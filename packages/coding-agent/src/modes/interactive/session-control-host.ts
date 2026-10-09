/**
 * What the interactive mode installs on its session so an extension can register a control
 * endpoint. It is the only piece loaded at startup: the endpoint itself is imported on the first
 * registration (a plain TUI never loads it), and it holds at most one endpoint per process.
 *
 * It also turns editor callbacks into the two editor edges. `draft_cleared` must not fire for a
 * submission, and the editor clears itself (`onChange("")`) synchronously BEFORE it calls
 * `onSubmit`, so the clear is judged one microtask later, after the submission had its chance to
 * claim it.
 *
 * A delivery never runs ahead of input the user already submitted. Every submission opens a
 * ticket, and admission is held while any ticket is open. A branch whose input still has to reach
 * the runtime claims the ticket (`claimHandoff`) - text buffered for the main loop, a steer into a
 * running turn - and releases it when the runtime took the input (its prompt reported a
 * disposition, or the prompt call ended). Every other submission has been handed to the runtime
 * (`session.prompt`, which holds admission itself from its entry - see
 * `ExternalAdmission.beginInput`) or to a built-in, once the handler's synchronous part returns, so
 * its ticket is released right there: a long-running `!` command never holds deliveries for its
 * whole runtime, while an extension command stays held by its prompt until it submitted its text or
 * its handler settled. Turn starts release
 * nothing: a turn can start (an extension's, the previous input's) while a later input is still
 * buffered. The last ticket's release is the `submission` edge.
 */
import type { RegisterControlEndpointOptions, SessionControlRegistration } from "../../core/extensions/types.ts";
import type { ControlEndpointHost } from "../../core/session-control-actions.ts";
import type { ActiveControlEndpoint, TuiControlContext } from "./session-control-lifecycle.ts";

interface ControlledEditor<SubmitDetails extends readonly unknown[]> {
	onChange?: (text: string) => void;
	onSubmit?: (text: string, ...details: SubmitDetails) => void;
}

export interface SubmissionTicket {
	/** Idempotent: the runtime took this input (or it will never reach the runtime). */
	release(): void;
}

export class TuiSessionControlHost implements ControlEndpointHost {
	private active: ActiveControlEndpoint | undefined;
	private editorRevision = 0;
	private hadDraft = false;
	private submitting = false;
	private openTickets = 0;
	private bufferedElsewhere = false;
	private handoff: SubmissionTicket | undefined;
	private readonly context: () => Omit<TuiControlContext, "editorRevision">;

	constructor(context: () => Omit<TuiControlContext, "editorRevision">) {
		this.context = context;
	}

	async register(options: RegisterControlEndpointOptions): Promise<SessionControlRegistration> {
		await this.disposeActive();
		const { registerSessionControlEndpoint } = await import("./session-control-endpoint.ts");
		const outcome = await registerSessionControlEndpoint(
			{ ...this.context(), editorRevision: () => this.editorRevision },
			options,
		);
		if ("endpoint" in outcome) this.active = outcome.endpoint;
		return outcome.registration;
	}

	/** Wraps the editor's callbacks; call after both are assigned. `hasDraft` reads the composer now. */
	attachEditor<SubmitDetails extends readonly unknown[]>(
		editor: ControlledEditor<SubmitDetails>,
		hasDraft: () => boolean,
	): void {
		const change = editor.onChange;
		editor.onChange = (text) => {
			change?.(text);
			this.editorChanged(hasDraft());
		};
		const submit = editor.onSubmit;
		editor.onSubmit = (text, ...details) => {
			this.submitting = true;
			queueMicrotask(() => {
				this.submitting = false;
			});
			const ticket = this.openTicket();
			this.handoff = ticket;
			try {
				submit?.(text, ...details);
			} finally {
				const claimed = this.handoff !== ticket;
				this.handoff = undefined;
				if (!claimed) ticket.release();
			}
		};
	}

	/** Called synchronously by a submit branch whose input still has to reach the runtime. */
	claimHandoff(): SubmissionTicket | undefined {
		const ticket = this.handoff;
		this.handoff = undefined;
		return ticket;
	}

	submissionInFlight(): boolean {
		return this.openTickets > 0 || this.bufferedElsewhere;
	}

	/** Input the TUI buffers outside the main loop (the compaction queue) holds admission the same way. */
	noteBufferedElsewhere(held: boolean): void {
		const released = this.bufferedElsewhere && !held;
		this.bufferedElsewhere = held;
		if (released) this.wakeIfUnheld();
	}

	questionsChanged(): void {
		this.active?.noteQuestions();
	}

	async disposeActive(): Promise<void> {
		const active = this.active;
		this.active = undefined;
		await active?.dispose();
	}

	private openTicket(): SubmissionTicket {
		this.openTickets += 1;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.openTickets -= 1;
				this.wakeIfUnheld();
			},
		};
	}

	private wakeIfUnheld(): void {
		// Deferred: a prompt reports its disposition just before the run marks itself active.
		queueMicrotask(() => {
			if (!this.submissionInFlight()) this.active?.wake("submission");
		});
	}

	private editorChanged(hasDraft: boolean): void {
		this.editorRevision += 1;
		const cleared = this.hadDraft && !hasDraft;
		this.hadDraft = hasDraft;
		this.active?.noteState();
		if (!cleared) return;
		queueMicrotask(() => {
			if (!this.submitting) this.active?.wake("draft_cleared");
		});
	}
}
