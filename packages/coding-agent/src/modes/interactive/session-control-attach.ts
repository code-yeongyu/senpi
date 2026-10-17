/**
 * What lets a terminal control endpoint serve its session the way a host does: a host
 * `SessionEventWriter` fed by the one session record projection (`subscribeSessionRecords`), so an
 * attached client reads the same records, ordering and in-flight replay as from a host, and a status
 * stream over this one session for `subscribe_sessions` (with the same `mirror` opt-in). Every
 * connection's answers go through the writer, so a command's answer is ordered with the records around it.
 *
 * The terminal itself is one attachment; each attached client adds one. A client that only subscribed
 * (mirror included) is not an attachment.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { SessionEventWriter } from "../rpc/session-event-writer.ts";
import { subscribeSessionRecords } from "../rpc/session-record-stream.ts";
import type { SessionStatusEntryView } from "../rpc/session-status.ts";
import { sessionRuntimeView } from "../rpc/session-status-source.ts";
import type { ControlConnection } from "./session-control-server.ts";

export class ControlAttachments {
	readonly writer = new SessionEventWriter(() => {});
	private readonly attached = new Set<string>();
	private readonly stopRecords: () => void;
	private readonly session: AgentSession;

	constructor(session: AgentSession, pendingQuestions: () => number) {
		this.session = session;
		this.writer.status.setSource({
			sessionIds: () => [this.handle],
			entryView: (id) => (id === this.handle ? this.entryView() : undefined),
			view: (id) =>
				id === this.handle
					? { entry: this.entryView(), runtime: sessionRuntimeView(session, pendingQuestions()) }
					: undefined,
		});
		// A permanent, never-attached connection keeps the writer off its stdio lane: records reach attached
		// connections and the replay snapshot only, and nothing queues for a sink that writes nowhere.
		this.writer.registerConnection(NULL_CONNECTION, { writeRaw: () => {}, waitForBackpressure: async () => {} });
		this.stopRecords = subscribeSessionRecords(session, (record) => this.writer.enqueue(this.handle, record));
	}

	/** The routing handle records carry: this terminal's session id. */
	get handle(): string {
		return this.session.sessionId;
	}

	opened(connection: ControlConnection): void {
		this.writer.registerConnection(keyOf(connection), connection.transport);
	}

	closed(connection: ControlConnection): void {
		const key = keyOf(connection);
		if (this.attached.delete(key)) this.writer.status.publish(this.handle, "detach", "client");
		this.writer.unregisterConnection(key);
	}

	/** Attaches the connection: it is replayed the in-flight snapshot, then receives the session's records. */
	attach(connection: ControlConnection): boolean {
		const key = keyOf(connection);
		if (this.attached.has(key)) return false;
		this.attached.add(key);
		this.writer.attachConnectionToSession(key, this.handle);
		this.writer.status.publish(this.handle, "attach", "client");
		return true;
	}

	isAttached(connection: ControlConnection): boolean {
		return this.attached.has(keyOf(connection));
	}

	/** Runs a command with this connection as the writer's current one (its targeted records reach it). */
	run<T>(connection: ControlConnection, task: () => T): T {
		return this.writer.withConnection(keyOf(connection), task);
	}

	respond(connection: ControlConnection, answer: object): void {
		this.writer.enqueueControl(answer, keyOf(connection)).catch(() => connection.transport.close?.());
	}

	dispose(): void {
		this.stopRecords();
	}

	private entryView(): SessionStatusEntryView {
		const manager = this.session.sessionManager;
		const path = this.session.sessionFile;
		const name = manager.getSessionName();
		return {
			state: "open",
			kind: "interactive",
			cwd: manager.getCwd(),
			attachments: 1 + this.attached.size,
			durableSessionId: this.session.sessionId,
			...(path !== undefined ? { sessionPath: path } : {}),
			...(name !== undefined ? { name } : {}),
			context: {},
		};
	}
}

const NULL_CONNECTION = "tui-null";

/** The writer's id for one control connection. */
export function keyOf(connection: ControlConnection): string {
	return `tui-${connection.id}`;
}
