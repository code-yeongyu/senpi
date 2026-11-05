import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { attachMcpGrantPresentation } from "../../core/mcp-grant-presentations.ts";
import type { SecurityNoticeSnapshot, SecurityNoticeState } from "../../core/security-notices.ts";
import { serializeJsonLine } from "./jsonl.ts";
import type { SessionEventFanout } from "./session-event-fanout.ts";

interface WorkerGrant {
	readonly connection: string | undefined;
	readonly cancel: () => void;
}
interface PresentationState {
	readonly durableId?: string;
	readonly select?: ExtensionUIContext["select"];
	readonly registrations: Map<string, () => void>;
	readonly grants: Map<string, WorkerGrant>;
	readonly replayed: Map<string, string>;
	snapshot: SecurityNoticeState;
	stop?: () => void;
}
/** Actual socket presentations; a shared session has one handler, not one per window. */
export class RpcSecurityPresentations {
	readonly #sessions = new Map<string, PresentationState>();
	readonly #attachments = new Map<string, Set<string>>();
	private readonly fanout: SessionEventFanout;
	private readonly inConnection: <T>(id: string, task: () => T) => T;
	private readonly flush: () => void;
	constructor(fanout: SessionEventFanout, inConnection: <T>(id: string, task: () => T) => T, flush: () => void) {
		this.fanout = fanout;
		this.inConnection = inConnection;
		this.flush = flush;
	}
	bind(
		sessionId: string,
		durableId: string,
		notices: SecurityNoticeSnapshot,
		select: ExtensionUIContext["select"],
	): () => void {
		const previous = this.#sessions.get(sessionId);
		this.#stop(previous);
		const state: PresentationState = {
			durableId,
			select,
			snapshot: notices.snapshot,
			registrations: new Map(),
			grants: new Map(),
			replayed: previous?.durableId === durableId ? previous.replayed : new Map(),
		};
		this.#sessions.set(sessionId, state);
		state.stop = notices.subscribe((snapshot) => this.acceptSnapshot(sessionId, snapshot));
		for (const id of this.fanout.attachedConnections(sessionId)) this.#register(id, state);
		return () => {
			if (this.#sessions.get(sessionId) !== state) return;
			this.#stop(state);
			this.#sessions.delete(sessionId);
		};
	}
	acceptSnapshot(sessionId: string, snapshot: SecurityNoticeState): void {
		let state = this.#sessions.get(sessionId);
		if (state === undefined) {
			state = { snapshot, registrations: new Map(), grants: new Map(), replayed: new Map() };
			this.#sessions.set(sessionId, state);
		}
		state.snapshot = snapshot;
		for (const id of this.fanout.attachedConnections(sessionId)) this.#replay(sessionId, id, snapshot);
	}
	attach(id: string, sessionId: string): void {
		const attached = this.#attachments.get(id) ?? new Set<string>();
		if (attached.has(sessionId)) return;
		attached.add(sessionId);
		this.#attachments.set(id, attached);
		const state = this.#sessions.get(sessionId);
		if (state !== undefined) {
			this.#register(id, state);
			this.#replay(sessionId, id, state.snapshot);
		}
	}
	detach(id: string, sessionId: string): void {
		this.#attachments.get(id)?.delete(sessionId);
		if (this.#attachments.get(id)?.size === 0) this.#attachments.delete(id);
		const state = this.#sessions.get(sessionId);
		state?.registrations.get(id)?.();
		state?.registrations.delete(id);
		state?.replayed.delete(id);
		if (state !== undefined) this.#cancelFor(state, id);
	}
	dropConnection(id: string): void {
		for (const sessionId of [...(this.#attachments.get(id) ?? [])]) this.detach(id, sessionId);
	}
	capabilitiesChanged(id: string): void {
		for (const sessionId of this.#attachments.get(id) ?? []) {
			const state = this.#sessions.get(sessionId);
			if (state === undefined) continue;
			this.#register(id, state);
			if (!this.fanout.connectionHas(id, "grant_select")) this.#cancelFor(state, id);
		}
	}
	routeWorkerGrant(
		sessionId: string,
		requestId: string,
		preferred: string | undefined,
		fallbackCapabilities: readonly string[],
		cancel: () => void,
	): { readonly accepted: boolean; readonly connection?: string } {
		const attached = this.fanout.attachedConnections(sessionId);
		const connection =
			attached.includes(preferred ?? "") && this.fanout.connectionHas(preferred, "grant_select")
				? preferred
				: attached.find((id) => this.fanout.connectionHas(id, "grant_select"));
		const accepted =
			connection !== undefined || (this.fanout.isEmpty() && fallbackCapabilities.includes("grant_select"));
		if (!accepted) {
			cancel();
			return { accepted: false };
		}
		let state = this.#sessions.get(sessionId);
		if (state === undefined) {
			state = {
				snapshot: { generation: 0, notices: [] },
				registrations: new Map(),
				grants: new Map(),
				replayed: new Map(),
			};
			this.#sessions.set(sessionId, state);
		}
		state.grants.set(requestId, { connection, cancel });
		return { accepted: true, connection };
	}
	acceptWorkerResponse(sessionId: string, requestId: string, connection: string | undefined): boolean | undefined {
		const state = this.#sessions.get(sessionId);
		const pending = state?.grants.get(requestId);
		if (pending === undefined) return undefined;
		if (
			pending.connection !== connection ||
			(connection !== undefined && !this.fanout.connectionHas(connection, "grant_select"))
		)
			return false;
		// The entry stays until the worker reports the grant settled (settleGrant): a frame the worker
		// refuses leaves the grant pending, and it must stay answerable only by its recipient.
		return true;
	}
	settleGrant(sessionId: string, requestId: string): void {
		this.#sessions.get(sessionId)?.grants.delete(requestId);
	}
	dropSession(sessionId: string): void {
		this.#stop(this.#sessions.get(sessionId));
		this.#sessions.delete(sessionId);
		for (const [id, sessions] of this.#attachments) {
			sessions.delete(sessionId);
			if (sessions.size === 0) this.#attachments.delete(id);
		}
	}
	#register(id: string, state: PresentationState): void {
		const capable = this.fanout.connectionHas(id, "grant_select");
		if (!capable) {
			state.registrations.get(id)?.();
			state.registrations.delete(id);
			return;
		}
		if (state.registrations.has(id) || state.select === undefined || state.durableId === undefined) return;
		const select = state.select;
		state.registrations.set(
			id,
			attachMcpGrantPresentation(state.durableId, (title, choices, opts) =>
				this.inConnection(id, () => select(title, choices, opts)),
			),
		);
	}
	#replay(sessionId: string, id: string, snapshot: SecurityNoticeState): void {
		const target = this.fanout.get(id);
		if (target === undefined) return;
		const state = this.#sessions.get(sessionId);
		const revision = JSON.stringify(snapshot);
		if (state?.replayed.get(id) === revision) return;
		state?.replayed.set(id, revision);
		for (const notice of snapshot.notices)
			target.actor.enqueue(
				serializeJsonLine({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					sessionId,
					method: "notify",
					notifyType: "warning",
					message: notice.message,
				}),
			);
		this.flush();
	}
	#cancelFor(state: PresentationState, id: string): void {
		for (const [requestId, pending] of state.grants)
			if (pending.connection === id) {
				state.grants.delete(requestId);
				pending.cancel();
			}
	}
	#stop(state: PresentationState | undefined): void {
		state?.stop?.();
		for (const stop of state?.registrations.values() ?? []) stop();
		for (const pending of state?.grants.values() ?? []) pending.cancel();
	}
}
