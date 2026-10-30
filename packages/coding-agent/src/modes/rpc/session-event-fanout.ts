import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { legacyAttachView, legacyResyncMessage } from "./compact-legacy-view.ts";
import { type FrozenCheckpoint, RecoveryCheckpoints } from "./compact-recovery-state.ts";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { ExtensionTransportOwner } from "./extension-owner.ts";
import { LegacyReplayStore } from "./legacy-replay-store.ts";
import { resyncCut } from "./legacy-resync-view.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import { type ShedMode, SocketEventSinkActor } from "./socket-event-fanout.ts";
import { EVENT_RESYNC_CAPABILITY } from "./socket-peer-recovery.ts";

export type RawWriter = (chunk: string) => void;
export type BackpressureWaiter = () => Promise<void>;

export interface SessionEventWriterConnection {
	readonly writeRaw: RawWriter;
	readonly waitForBackpressure: BackpressureWaiter;
	/**
	 * Tears the transport down. Called when this connection's event queue fails
	 * (overflow, write error): the actor has already stopped delivering records
	 * AND command responses, so a socket left open would strand the client on a
	 * connection that can never answer again. Closing it lets the client resync.
	 */
	readonly close?: () => void;
}

const BROADCAST_LIFECYCLE_RECORDS = new Set([
	"agent_start",
	"agent_settled",
	"agent_idle",
	"session_opened",
	"session_closed",
	"session_lifecycle",
]);

type RegisteredConnection = {
	readonly connection: SessionEventWriterConnection;
	readonly actor: SocketEventSinkActor;
	/** This registration's incarnation of the peer: the owner every checkpoint it freezes is bound to. */
	readonly socketEpoch: string;
	readonly owner: ExtensionTransportOwner;
};

/** A checkpoint pinned for one frozen view, released once on that view's end (R3.C1.5). */
type PinnedRoot = FrozenCheckpoint & { readonly sessionId: string };

export class SessionEventFanout {
	onConnectionClosed?: (id: string) => void;
	/** Each routing session's acceptance lane; retired when the session is sealed or forgotten. */
	readonly acceptance = new Map<string, SessionAcceptanceLane>();
	/** Today's retention for a session without a lane (RULING-25 Q5), and the open-view count of both sources. */
	readonly replay = new LegacyReplayStore();
	/** The checkpoint tokens this host froze for its peers' baselines and recoveries (S08a). */
	readonly checkpoints = new RecoveryCheckpoints();
	private socketEpochs = 0;
	/** Today's shed path with the compact-updates flag off; the cut frozen at the shed with it on. */
	private readonly shedMode: ShedMode = compactUpdatesEnabled() ? "capture" : "drop";
	private readonly connections = new Map<string, RegisteredConnection>();
	private readonly connectionCapabilities = new Map<string, Set<string>>();
	/** Per connection, each attached session with the ordinal of the attach that holds it. */
	private readonly connectionSessions = new Map<string, Map<string, number>>();
	private attachOrdinal = 0;
	/** Roots an attach baseline still reads; a seal keeps them readable until that view ends (RULING-51 Q2=A). */
	private readonly attachViews = new Set<FrozenAcceptedRoot>();
	private readonly registeredCapabilityConnections = new Set<string>();

	registerConnection(
		id: string,
		connection: SessionEventWriterConnection,
		options: { readonly maxQueueBytes?: number; readonly stallMs?: number } = {},
	): void {
		this.unregisterConnection(id);
		const owner = new ExtensionTransportOwner();
		const socketEpoch = `socket-${++this.socketEpochs}`;
		const actor = new SocketEventSinkActor(
			connection,
			(cause) => {
				if (this.connections.get(id)?.actor === actor) {
					owner.retire();
					this.connections.delete(id);
					this.connectionCapabilities.delete(id);
					this.connectionSessions.delete(id);
					this.registeredCapabilityConnections.delete(id);
					this.checkpoints.forgetPeer(socketEpoch);
					this.onConnectionClosed?.(id);
				}
				process.stderr.write(
					`senpi rpc connection ${id} event queue failed; closing: ${cause instanceof Error ? cause.message : String(cause)}\n`,
				);
				connection.close?.();
			},
			options.maxQueueBytes,
			options.stallMs,
			this.shedMode,
		);
		this.connections.set(id, { connection, actor, socketEpoch, owner });
		this.connectionCapabilities.set(id, new Set());
		this.connectionSessions.set(id, new Map());
	}

	unregisterConnection(id: string): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		registered.owner.retire();
		registered.actor.close();
		this.checkpoints.forgetPeer(registered.socketEpoch);
		this.connections.delete(id);
		this.connectionCapabilities.delete(id);
		this.connectionSessions.delete(id);
		this.registeredCapabilityConnections.delete(id);
	}

	/**
	 * A first attach is one admission: it freezes the cut C synchronously as that admission's checkpoint (the lane
	 * root, read later for the baseline; today's replay view for a session without a lane) and installs that peer's
	 * baseline barrier before the session is live for it; a repeated hold adds nothing. The attempt dies with a
	 * detach, the peer, or a replacement (new lane epoch), and releases its checkpoint in every case.
	 */
	attachConnectionToSession(id: string, sessionId: string): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		const sessions = this.connectionSessions.get(id) ?? new Map<string, number>();
		if (sessions.has(sessionId)) return;
		const ordinal = ++this.attachOrdinal;
		sessions.set(sessionId, ordinal);
		this.connectionSessions.set(id, sessions);
		const pinned = this.pin(id, [sessionId]);
		for (const { root } of pinned) this.attachViews.add(root);
		const release = () => {
			for (const { root } of pinned) this.attachViews.delete(root);
			this.unpin(pinned);
		};
		const view = { placeholders: this.connectionHas(id, MEDIA_PLACEHOLDERS_CAPABILITY), now: Date.now() };
		const cursor = this.acceptance.has(sessionId)
			? legacyAttachView(sessionId, pinned[0], view, this.replay.track(release))
			: this.replay.freezeAttach(sessionId, { ...view, onRelease: release });
		registered.actor.installBaseline(
			cursor,
			() =>
				this.connections.get(id)?.actor === registered.actor &&
				this.connectionSessions.get(id)?.get(sessionId) === ordinal &&
				pinned.every(({ lane, root }) => lane.sessionEpoch === root.sessionEpoch),
		);
	}

	detachConnectionFromSession(id: string, sessionId: string): void {
		this.connectionSessions.get(id)?.delete(sessionId);
	}

	setConnectionCapabilities(id: string, capabilities: readonly string[]): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		this.connectionCapabilities.set(id, new Set(capabilities));
		this.registeredCapabilityConnections.add(id);
		if (capabilities.includes(EVENT_RESYNC_CAPABILITY)) {
			// Checkpoints frozen at the shed, before the actor awaits its drain (R3.C1.5), as the next generation of each
			// held admission; released when the recovery ends.
			registered.actor.enableRecovery((reason, carried = []) => {
				const capture = this.shedMode === "capture";
				const attached = this.held(id);
				const ordinals = new Map(this.connectionSessions.get(id));
				const pinned = this.pin(id, attached);
				const roots = new Map(pinned.map((root) => [root.sessionId, root]));
				const view = {
					reason,
					placeholders: this.connectionHas(id, MEDIA_PLACEHOLDERS_CAPABILITY),
					// Capture: closed once the attachment held at the shed is gone (carry 30); drop: today's rule.
					closedNow: (sessionId: string) =>
						capture
							? this.connectionSessions.get(id)?.get(sessionId) !== ordinals.get(sessionId) ||
								!ordinals.has(sessionId)
							: !this.holds(id, sessionId),
					onRelease: () => this.unpin(pinned),
				};
				const sessions = capture ? [...new Set([...carried, ...attached])] : attached;
				return resyncCut(
					sessions,
					capture ? () => sessions : () => [...new Set([...sessions, ...this.held(id)])],
					(sessionId) =>
						this.acceptance.has(sessionId)
							? legacyResyncMessage(sessionId, roots.get(sessionId))
							: Promise.resolve(this.replay.latestMessage(sessionId)),
					view,
					this.replay.track,
				);
			});
		} else registered.actor.disableRecovery();
	}

	clearConnectionCapabilities(id: string): void {
		if (this.connections.has(id)) {
			this.connectionCapabilities.set(id, new Set());
			this.registeredCapabilityConnections.delete(id);
		}
	}

	hasRegisteredConnectionCapabilities(id: string): boolean {
		return this.registeredCapabilityConnections.has(id);
	}

	getConnectionCapabilities(id: string): readonly string[] | undefined {
		if (!this.registeredCapabilityConnections.has(id)) return undefined;
		return [...(this.connectionCapabilities.get(id) ?? [])];
	}

	/** Whether a connection advertised a capability. The only capability lookup in this file. */
	connectionHas(id: string | undefined, capability: string): boolean {
		return id === undefined ? false : (this.connectionCapabilities.get(id)?.has(capability) ?? false);
	}

	targets(
		sessionId: string,
		targetId: string | undefined,
		isTargeted: boolean,
		recordType: unknown,
	): readonly (string | undefined)[] {
		if (isTargeted) return [targetId];
		if (typeof recordType === "string" && BROADCAST_LIFECYCLE_RECORDS.has(recordType))
			return this.connections.size > 0 ? [...this.connections.keys()] : [undefined];
		return this.connections.size > 0
			? [...this.connections.keys()].filter((id) => this.connectionSessions.get(id)?.has(sessionId))
			: [undefined];
	}

	/** For a record that reaches `id` because it holds `sessionId`: whether that attachment still does; undefined for every other audience. */
	attachmentOf(id: string, sessionId: string, isTargeted: boolean, recordType: unknown): (() => boolean) | undefined {
		if (isTargeted || (typeof recordType === "string" && BROADCAST_LIFECYCLE_RECORDS.has(recordType)))
			return undefined;
		return this.attachment(id, sessionId);
	}

	get(id: string): RegisteredConnection | undefined {
		return this.connections.get(id);
	}

	values(): IterableIterator<RegisteredConnection> {
		return this.connections.values();
	}

	/** True when no socket connection is registered, i.e. records must fall back to the stdio lane. */
	isEmpty(): boolean {
		return this.connections.size === 0;
	}

	broadcast(line: string): void {
		for (const { actor } of this.connections.values()) actor.enqueue(line);
	}

	connectionIds(): readonly string[] {
		return [...this.connections.keys()];
	}

	attachedConnections(sessionId: string): readonly string[] {
		return [...this.connections.keys()].filter((id) => this.connectionSessions.get(id)?.has(sessionId));
	}

	/**
	 * Pending `question` frames a session has asked and nobody answered yet: the lane's hot count, today's count for a
	 * session without a lane, and undefined (unknown) for a lane whose compact state is unavailable. The unknown count
	 * is output-equivalent to the old 0: `liveStatus` reads it as `?? 0`, so the runtime's own count decides.
	 */
	pendingQuestionCount(sessionId: string): number | undefined {
		const lane = this.acceptance.get(sessionId);
		return lane ? lane.openBroadcastDialogs : this.replay.pendingQuestionCount(sessionId);
	}

	/** Deliver one line to the connections attached to a session, never to the rest of the fanout. */
	deliverToSession(sessionId: string, line: string): void {
		for (const [id, { actor }] of this.connections) {
			const held = this.attachment(id, sessionId);
			if (held) actor.enqueue(line, undefined, undefined, undefined, false, held);
		}
	}

	/** Retention only for a session without a lane; a lane-owned session's late peers read its frozen view. */
	rememberSnapshot(sessionId: string, value: Record<string, unknown>, line: string, placeholderLine?: string): void {
		if (!this.acceptance.has(sessionId)) this.replay.remember(sessionId, value, line, placeholderLine);
	}

	forgetSession(sessionId: string): void {
		this.acceptance.get(sessionId)?.retire("close", this.attachViews);
		this.acceptance.delete(sessionId);
		this.replay.forget(sessionId);
	}

	private holds(id: string, sessionId: string): boolean {
		return this.connectionSessions.get(id)?.has(sessionId) ?? false;
	}

	/**
	 * The attach holding `sessionId` for `id` now, as a liveness check: true only while that same attach (its ordinal,
	 * the rule an attach baseline's liveness uses) still holds it, so a detach and re-attach ends it.
	 */
	private attachment(id: string, sessionId: string): (() => boolean) | undefined {
		const ordinal = this.connectionSessions.get(id)?.get(sessionId);
		return ordinal === undefined ? undefined : () => this.connectionSessions.get(id)?.get(sessionId) === ordinal;
	}

	private held(id: string): readonly string[] {
		return [...(this.connectionSessions.get(id)?.keys() ?? [])];
	}

	/** One checkpoint per held lane-owned session, on the admission (the attach ordinal) that holds it for `id`. */
	private pin(id: string, sessionIds: readonly string[]): readonly PinnedRoot[] {
		const socketEpoch = this.connections.get(id)?.socketEpoch;
		return sessionIds.flatMap((sessionId) => {
			const lane = this.acceptance.get(sessionId);
			const ordinal = this.connectionSessions.get(id)?.get(sessionId);
			if (!lane || ordinal === undefined || socketEpoch === undefined) return [];
			const route = {
				socketEpoch,
				admissionId: `attach-${ordinal}`,
				routeKind: "ordinary" as const,
				peer: id,
				sessionId,
			};
			const frozen = this.checkpoints.freeze(route, lane);
			return frozen.ok ? [{ sessionId, ...frozen.value }] : [];
		});
	}

	private unpin(pinned: readonly PinnedRoot[]): void {
		for (const { token } of pinned) this.checkpoints.release(token);
	}
}
