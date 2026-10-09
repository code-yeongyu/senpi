/**
 * `pi.session.registerControlEndpoint` for a session a multi-session host serves, and the host's
 * `wake` command for it.
 *
 * The host's public socket already is the session's endpoint - a caller reaches it with
 * `wake { sessionId }` - so registering binds nothing: it installs the registrant's drain and wakes
 * it on the same edges a terminal endpoint uses (`session-control-wake.ts`): `agent_idle`, an
 * admitted delivery reaching the transcript, an inbox entry, and the `wake` command. One pass runs at
 * a time, so the answer to `wake` is the outcome of the pass that covered it - the contract of the
 * terminal endpoint's `wake`, which is what lets one sender wake every recipient kind the same way.
 *
 * A host with no public socket (stdio) has nothing another process can reach, so a registration
 * there answers `unsupported_mode`. `wake` always answers: with no drain registered it still emits
 * `session_control_wake` into the session's extensions and reports `admitted: []`.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import type {
	RegisterControlEndpointOptions,
	SessionControlDrainResult,
	SessionControlRegistration,
	SessionControlWakeReason,
} from "../../core/extensions/types.ts";
import type { ControlEndpointHost } from "../../core/session-control-actions.ts";
import { type InboxWatch, WakeScheduler, watchInbox } from "../interactive/session-control-wake.ts";

interface ActiveRegistration {
	readonly scheduler: WakeScheduler;
	readonly release: () => void;
}

export class HostSessionControl implements ControlEndpointHost {
	private active: ActiveRegistration | undefined;
	private disposed = false;
	private readonly session: AgentSession;
	private readonly socket: string | undefined;
	private readonly report: (line: string) => void;

	constructor(session: AgentSession, socket: string | undefined, report: (line: string) => void) {
		this.session = session;
		this.socket = socket;
		this.report = report;
	}

	async register(options: RegisterControlEndpointOptions): Promise<SessionControlRegistration> {
		this.releaseActive();
		if (this.disposed || this.socket === undefined) return { status: "unsupported", reason: "unsupported_mode" };
		const { session } = this;
		const scheduler = new WakeScheduler(
			async (event) => {
				await session.extensionRunner.emit(event);
				return (await options.drain(event)) ?? { admitted: [] };
			},
			(error) => this.report(`control drain failed: ${errorText(error)}`),
		);
		const wake = (reason: SessionControlWakeReason): void => void scheduler.request(reason);
		const unsubscribeIdle = session.subscribe((event) => {
			if (event.type === "agent_idle") wake("idle");
		});
		const unsubscribeEmitted = session.externalAdmission.onEmitted(() => wake("emitted"));
		let inbox: InboxWatch | undefined;
		const registration: ActiveRegistration = {
			scheduler,
			release: () => {
				unsubscribeIdle();
				unsubscribeEmitted();
				inbox?.stop();
				scheduler.dispose();
			},
		};
		try {
			inbox = await watchInbox(
				options.inboxDir,
				() => wake("inbox"),
				(error) => this.report(`control inbox watch failed: ${errorText(error)}`),
			);
		} catch (error) {
			registration.release();
			return { status: "failed", reason: errorText(error) };
		}
		// A rebind may dispose this host while the watch arms; a registration it outlived stays inert.
		if (this.disposed) {
			registration.release();
			return { status: "unsupported", reason: "unsupported_mode" };
		}
		this.releaseActive();
		this.active = registration;
		// Anything that reached the inbox before this point is picked up by this first pass, and anything
		// written after it but before the watch was armed (no event for it) by the pass once arming settled.
		wake("inbox");
		void inbox.armed.then(() => wake("inbox"));
		return {
			status: "registered",
			socket: this.socket,
			dispose: async () => {
				if (this.active === registration) this.releaseActive();
			},
		};
	}

	/** The `wake` command: one drain pass covering `deliveryIds`, answered with what it admitted. */
	async wake(deliveryIds?: readonly string[]): Promise<SessionControlDrainResult> {
		const active = this.active;
		if (active !== undefined) return active.scheduler.request("command", deliveryIds);
		const ids = deliveryIds === undefined || deliveryIds.length === 0 ? {} : { delivery_ids: deliveryIds };
		await this.session.extensionRunner.emit({
			type: "session_control_wake",
			reason: "command",
			reasons: ["command"],
			...ids,
		});
		return { admitted: [] };
	}

	/** Synchronous so a rebind never gains an await: every edge source stops here. */
	dispose(): void {
		this.disposed = true;
		this.releaseActive();
	}

	private releaseActive(): void {
		const active = this.active;
		this.active = undefined;
		active?.release();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
