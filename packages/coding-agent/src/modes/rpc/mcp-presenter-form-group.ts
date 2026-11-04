import { randomUUID } from "node:crypto";
import type { McpFormInput, McpFormOutcome, McpFormResolved, McpFormSettled } from "../../core/mcp-form-types.ts";
import { McpFormDialog, type McpFormClock, type McpFormHolder } from "./mcp-form-dialog.ts";

type Termination = "presentation_lost" | "presentation_timeout" | "operation_aborted";

function reasonOf(outcome: McpFormOutcome): McpFormResolved["reason"] {
	if (outcome.kind !== "result")
		return outcome.kind === "operation_aborted" ? "operation_aborted" : "processing_failed";
	const action = outcome.result.action;
	return action === "accept" ? "answered" : action === "decline" ? "declined" : "cancelled";
}

/**
 * One form offered to every holder current when it reached the head of its binding's FIFO (D11 S3-3b).
 * One synchronous terminal latch for the whole group: the first valid human action, or the host termination,
 * settles it once; every other holder's dialog then resolves with the winning reason.
 */
export class McpFormGroup {
	readonly id = randomUUID();
	readonly input: McpFormInput;
	readonly result: Promise<McpFormOutcome>;
	private readonly deadline: number;
	private readonly context: {
		readonly clock: McpFormClock;
		readonly sessionId: string;
		readonly admit: () => void;
	};
	private settled = false;
	private presented = false;
	private readonly members = new Set<McpFormDialog>();
	private readonly cleanups: Array<() => void> = [];
	private resolve: (outcome: McpFormOutcome) => void = () => {};

	constructor(
		input: McpFormInput,
		context: { readonly clock: McpFormClock; readonly sessionId: string; readonly admit: () => void },
	) {
		this.input = input;
		this.context = context;
		this.deadline = context.clock.now() + Math.max(0, input.deadlineMs);
		this.result = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	join(holder: McpFormHolder): McpFormDialog {
		const dialog = new McpFormDialog(this, holder);
		this.members.add(dialog);
		return dialog;
	}

	start(): void {
		// The timer is a cleanup before any watcher can settle, so an early settle leaves nothing scheduled.
		const timer = this.context.clock.schedule(() => this.terminate("presentation_timeout"), this.input.deadlineMs);
		this.cleanups.push(() => this.context.clock.cancel(timer));
		const watch = (signal: AbortSignal, cause: Termination) => {
			const stop = () => this.terminate(cause);
			signal.addEventListener("abort", stop, { once: true });
			this.cleanups.push(() => signal.removeEventListener("abort", stop));
			if (signal.aborted) stop();
		};
		watch(this.input.operationSignal, "operation_aborted");
		watch(this.input.presentationSignal, "presentation_lost");
		// A settle closes every member, so a holder answering inside `send` stops the later deliveries.
		for (const dialog of [...this.members]) dialog.deliver();
	}

	live(): boolean {
		if (this.input.operationSignal.aborted || this.input.operationCurrent?.() === false) {
			this.terminate("operation_aborted");
			return false;
		}
		if (this.context.clock.now() >= this.deadline) {
			this.terminate("presentation_timeout");
			return false;
		}
		return true;
	}

	/** Presentation by any holder decides the cancel-versus-processing-failure rule for the group. */
	markPresented(): void {
		this.presented = true;
	}

	/** A lost holder leaves; the group ends with `presentation_lost` only when its last holder is gone. */
	leave(dialog: McpFormDialog): void {
		this.members.delete(dialog);
		if (this.members.size === 0) this.terminate("presentation_lost");
	}

	/** Internal-only: never called with a cause decoded from RPC. */
	terminate(cause: Termination): void {
		const provenance = { source: "host_termination", humanAdmission: false } as const;
		if (
			cause === "operation_aborted" ||
			this.input.operationSignal.aborted ||
			this.input.operationCurrent?.() === false
		)
			this.settle({ kind: "operation_aborted", ...provenance });
		else if (this.presented) this.settle({ kind: "result", result: { action: "cancel" }, ...provenance });
		else this.settle({ kind: "processing_failure", ...provenance });
	}

	settle(outcome: McpFormOutcome, winner?: McpFormDialog): void {
		if (this.settled) return;
		this.settled = true;
		const members = [...this.members];
		this.members.clear();
		for (const member of members) member.close();
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		// No callback, promise resolution or admission precedes the synchronous terminal claim.
		if (outcome.humanAdmission) this.context.admit();
		this.resolve(outcome);
		const reason = reasonOf(outcome);
		for (const member of members) member.resolved(reason, winner !== undefined && member !== winner);
		const record: McpFormSettled = {
			type: "mcp_form_settled",
			sessionId: this.context.sessionId,
			groupId: this.id,
			outcome: reason,
			...(winner ? { answeredBy: winner.holder.answeredBy } : {}),
		};
		for (const member of members) member.settled(record);
	}
}
