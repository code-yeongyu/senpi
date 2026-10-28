import type { ExtensionUIContext, SessionKind } from "../../core/extensions/types.ts";
import type { SecurityNoticeSnapshot, SecurityNoticeState } from "../../core/security-notices.ts";
import type { CanonicalControl } from "./compact-canonical-pairing.ts";
import { serializeJsonLine } from "./jsonl.ts";
import type { MediaPersister } from "./media-placeholders.ts";
import type { SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import type { SessionEventWriterConnection } from "./session-event-fanout.ts";
import { acceptActors, SessionEventWriterLanes, settleActors } from "./session-event-writer-lanes.ts";
import type { SocketEventSinkActor } from "./socket-event-fanout.ts";

/** Connection registration, capabilities, security presentations and per-session delivery settings. */
export abstract class SessionEventWriterConnections extends SessionEventWriterLanes {
	isSessionSealed(sessionId: string): boolean {
		return this.sealedSessions.has(sessionId);
	}

	registerConnection(
		id: string,
		connection: SessionEventWriterConnection,
		options: { readonly maxQueueBytes?: number; readonly stallMs?: number } = {},
	): void {
		const previousPresenter = this.presenterConnections.get(id);
		if (previousPresenter) this.presenterAuthority?.detach(previousPresenter);
		this.fanout.registerConnection(id, connection, options);
		if (this.presenterAuthority) {
			const sender = this.presenterAuthority.connect(id, (frame) => {
				if (!this.fanout.get(id)) return false;
				try {
					connection.writeRaw(serializeJsonLine(frame));
					// A pending drain does not undo an accepted write or drop the next resolution.
					void connection.waitForBackpressure().catch(() => this.presenterAuthority?.detach(sender));
					return true;
				} catch {
					this.presenterAuthority?.detach(sender);
					return false;
				}
			});
			this.presenterConnections.set(id, sender);
		}
	}

	unregisterConnection(id: string): void {
		const sender = this.presenterConnections.get(id);
		if (sender) this.presenterAuthority?.detach(sender);
		this.presenterConnections.delete(id);
		this.securityPresentations.dropConnection(id);
		this.fanout.unregisterConnection(id);
		this.status.dropConnection(id);
		this.surfaceDedupe.dropConnection(id);
	}

	attachConnectionToSession(id: string, sessionId: string): void {
		this.fanout.attachConnectionToSession(id, sessionId);
		if (this.hasConnection(id)) this.securityPresentations.attach(id, sessionId);
		const sender = this.presenterConnections.get(id);
		const binding = this.presenterBindings.get(sessionId);
		if (sender && binding) this.presenterAuthority?.attach(sender, binding);
	}

	detachConnectionFromSession(id: string, sessionId: string): void {
		const sender = this.presenterConnections.get(id);
		const binding = this.presenterBindings.get(sessionId);
		if (sender && binding) this.presenterAuthority?.detach(sender, binding);
		this.fanout.detachConnectionFromSession(id, sessionId);
		this.securityPresentations.detach(id, sessionId);
	}

	hasConnection(id: string): boolean {
		return this.fanout.get(id) !== undefined;
	}

	setConnectionCapabilities(id: string, capabilities: readonly string[]): void {
		this.fanout.setConnectionCapabilities(id, capabilities);
		this.securityPresentations.capabilitiesChanged(id);
		if (!capabilities.includes("interactive_user") || !capabilities.includes("mcp_form_presenter_v1")) {
			const sender = this.presenterConnections.get(id);
			if (sender) this.presenterAuthority?.withdraw(sender);
		}
	}

	clearConnectionCapabilities(id: string): void {
		const sender = this.presenterConnections.get(id);
		if (sender) this.presenterAuthority?.withdraw(sender);
		this.fanout.clearConnectionCapabilities(id);
		this.securityPresentations.capabilitiesChanged(id);
	}
	bindSecurityPresentations(
		sessionId: string,
		durableId: string,
		notices: SecurityNoticeSnapshot,
		ui: ExtensionUIContext,
	): (() => void) | undefined {
		if (this.fanout.isEmpty()) return undefined;
		return this.securityPresentations.bind(sessionId, durableId, notices, ui.select);
	}
	acceptWorkerSecuritySnapshot(sessionId: string, snapshot: SecurityNoticeState): void {
		this.securityPresentations.acceptSnapshot(sessionId, snapshot);
	}
	routeWorkerGrant(
		sessionId: string,
		requestId: string,
		preferred: string | undefined,
		capabilities: readonly string[],
		cancel: () => void,
	): { readonly accepted: boolean; readonly connection?: string } {
		return this.securityPresentations.routeWorkerGrant(sessionId, requestId, preferred, capabilities, cancel);
	}
	acceptWorkerGrantResponse(sessionId: string, id: string, connection: string | undefined): boolean | undefined {
		return this.securityPresentations.acceptWorkerResponse(sessionId, id, connection);
	}
	settleGrantDialog(sessionId: string, id: string): void {
		this.securityPresentations.settleGrant(sessionId, id);
	}

	hasRegisteredConnectionCapabilities(id: string): boolean {
		return this.fanout.hasRegisteredConnectionCapabilities(id);
	}

	getConnectionCapabilities(id: string): readonly string[] | undefined {
		return this.fanout.getConnectionCapabilities(id);
	}

	/**
	 * Records a session's visibility class. A worker session is machine-driven work that
	 * only its attached connections track, so its lifecycle records are delivered to them
	 * instead of broadcast; an interactive session keeps the broadcast every client (the
	 * desktop mirror, the supervisor's idle observer) relies on.
	 */
	setSessionMedia(sessionId: string, persister: MediaPersister | undefined): void {
		if (persister === undefined) this.mediaPersisters.delete(sessionId);
		else this.mediaPersisters.set(sessionId, persister);
	}

	/** A worker isolate frames a canonical-only unit; an in-process host folds block controls in its own lane. */
	enqueueCanonical(_sessionId: string, _control: CanonicalControl): void {}

	/** A worker isolate reports a lost canonical record to its host lane; an in-process binding tells its lane directly. */
	canonicalUnavailable(_sessionId: string, _cause: unknown): void {}

	/** The session's records reach `lane` before `enqueue`; sealing or forgetting the session retires it. */
	registerAcceptance(sessionId: string, lane: SessionAcceptanceLane): void {
		if (!this.sealedSessions.has(sessionId)) this.fanout.acceptance.set(sessionId, lane);
	}

	setSessionKind(sessionId: string, kind: SessionKind): void {
		if (kind === "worker") this.workerSessions.add(sessionId);
		else this.workerSessions.delete(sessionId);
	}

	/** Drain just this connection before closing it after its last handoff park. */
	async flushConnection(id: string): Promise<void> {
		const target = this.fanout.get(id);
		if (target) await settleActors([target.actor]);
	}

	/** Execute a connection's command with its response destination in context. */
	withConnection<T>(id: string, task: () => T): T {
		return this.connectionContext.run(id, task);
	}

	/** Connection id of the command currently being dispatched, when one owns it. */
	currentConnection(): string | undefined {
		return this.connectionContext.getStore();
	}

	/**
	 * Return worker credit once this session's destinations have ACCEPTED the record
	 * into their bounded queues - never when the slowest peer's kernel has drained it.
	 * A client that is merely busy would otherwise pace the producing worker into
	 * session_worker_credit_timeout and force the dead-peer budget under
	 * SESSION_WORKER_LIMITS.controlMs (#1774). Delivery stays bounded by each queue's
	 * maxQueueBytes and its dead-peer cut. A destination that failed (byte overflow or
	 * stall) was already cut and closed by the fanout's onFailure; it is a cut peer,
	 * not a writer failure. The shared stdio lane keeps its stdout backpressure wait.
	 */
	waitForSessionBackpressure(sessionId: string): Promise<void> {
		if (this.fanout.isEmpty()) return this.flush();
		return acceptActors(this.sessionActors(sessionId));
	}

	/** Registered actors this session's records are delivered to, plus the caller's own. */
	private sessionActors(sessionId: string): SocketEventSinkActor[] {
		const targets = new Set([
			...this.fanout.targets(sessionId, this.currentConnection(), false, undefined),
			this.currentConnection(),
		]);
		return [...targets].flatMap((target) => {
			const registered = target === undefined ? undefined : this.fanout.get(target);
			return registered ? [registered.actor] : [];
		});
	}
}
