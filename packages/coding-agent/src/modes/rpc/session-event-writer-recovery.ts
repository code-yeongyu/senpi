import type { EventLeases } from "./compact-event-leases.ts";
import { captureAdmissionReply } from "./compact-admission-reply.ts";
import { AdmissionRoutingActor } from "./compact-admission-routing.ts";
import { CompactRequiredStreams } from "./compact-required-streams.ts";
import type { LegacyViewCursor } from "./legacy-view-cursor.ts";
import type { RecoveryPageRequests } from "./compact-recovery-requests.ts";
import type { RecoveryCheckpoints } from "./compact-recovery-state.ts";
import { SessionEventWriterLifecycle } from "./session-event-writer-lifecycle.ts";

/** The writer's recovery accessors (senpi#4272): legacy views, checkpoint tokens, page requests, peer epochs. */
export abstract class SessionEventWriterRecovery extends SessionEventWriterLifecycle {
	protected readonly required = new CompactRequiredStreams(this.fanout, this.status);
	protected prepareDelivery(sessionId: string, record?: object): void {
		this.fanout.requiredSessions = (peer) => this.required.sessions(peer);
		this.fanout.onSessionForgotten = (id) => this.required.forgetSession(id);
		this.required.prepare(sessionId, record);
	}
	holdsAdmission(peer: string, admissionId: string, sessionId?: string): boolean {
		const actor = this.fanout.get(peer)?.actor;
		if (!(actor instanceof AdmissionRoutingActor)) return false;
		for (const [subscriptionId, id] of actor.subscriptions)
			if (id === admissionId && (sessionId === undefined || subscriptionId === sessionId)) return true;
		if (sessionId !== undefined && this.isCompactSubscription(peer, admissionId, sessionId)) return true;
		if (!actor.admissions.has(admissionId)) return false;
		return sessionId === undefined || this.ordinaryRoute(peer, sessionId)?.routes.includes(admissionId) === true;
	}
	unregisterAdmission(peer: string, admissionId: string): void {
		const actor = this.fanout.get(peer)?.actor;
		if (actor instanceof AdmissionRoutingActor) actor.admissions.delete(admissionId);
	}
	ordinaryRoute(peer: string, sessionId: string) {
		const registered = this.fanout.get(peer);
		const actor = registered?.actor;
		return registered && actor instanceof AdmissionRoutingActor
			? actor.remember(sessionId, this.fanout.checkpoints, registered.socketEpoch)
			: undefined;
	}
	registerSubscription(peer: string, admissionId: string, subscriptionId: string): void {
		const actor = this.fanout.get(peer)?.actor;
		if (!(actor instanceof AdmissionRoutingActor)) return;
		actor.subscriptions.set(subscriptionId, admissionId);
		actor.mirrorOwners.set(subscriptionId, admissionId);
		const pending = this.status.pendingBuffer(subscriptionId);
		if (pending) actor.pendingMirrors.set(admissionId, pending);
		for (const sessionId of this.status.requiredSessions(peer)) this.prepareDelivery(sessionId);
		this.status.onSubscriptionEnd = (owner, id) => this.retireMirror(owner, id);
		actor.mirrorAdmissions = (sessionId, type) => {
			const ids = this.status.mirrorAdmissions(peer, sessionId, type);
			const socketEpoch = this.socketEpochOf(peer);
			const lane = this.recoveryLane(sessionId);
			return ids.filter((id) => {
				if (!lane || lane.retired)
					return (
						actor.remember(sessionId, this.recoveryCheckpoints, socketEpoch ?? "")?.routes.includes(id) === true
					);
				if (socketEpoch && this.recoveryCheckpoints.stream({ socketEpoch, sessionId })?.routes.includes(id))
					return true;
				if (socketEpoch && lane) {
					const frozen = this.recoveryCheckpoints.freeze(
						{ socketEpoch, sessionId, peer, admissionId: id, routeKind: "mirror" },
						lane,
						true,
					);
					if (frozen.ok) return true;
				}
				actor.pendingMirrors.get(id)?.retire("storage_unavailable");
				process.stderr.write(`senpi rpc mirror checkpoint unavailable (${type}); closing connection\n`);
				this.fanout.get(peer)?.connection.close?.();
				return true;
			});
		};
	}
	private retireMirror(peer: string, subscriptionId: string): void {
		const registered = this.fanout.get(peer);
		const actor = registered?.actor;
		if (!(actor instanceof AdmissionRoutingActor) || !registered) return;
		const admissionId = actor.mirrorOwners.get(subscriptionId);
		if (admissionId === undefined) return;
		actor.pendingMirrors.get(admissionId)?.retire();
		actor.pendingMirrors.delete(admissionId);
		actor.mirrorOwners.delete(subscriptionId);
		this.unregisterSubscription(peer, subscriptionId);
		for (const sessionId of this.fanout.acceptance.keys())
			this.recoveryCheckpoints.retireRoute({ socketEpoch: registered.socketEpoch, sessionId }, admissionId);
	}
	unregisterSubscription(peer: string, subscriptionId: string): void {
		const registered = this.fanout.get(peer);
		const actor = registered?.actor;
		if (!(actor instanceof AdmissionRoutingActor)) return;
		const admissionId = actor.subscriptions.get(subscriptionId);
		actor.subscriptions.delete(subscriptionId);
		if (admissionId !== undefined && registered)
			this.recoveryEvents?.forgetAdmission(
				{ socketEpoch: registered.socketEpoch, sessionId: subscriptionId },
				admissionId,
			);
	}
	isCompactSubscription(peer: string, admissionId: string, subscriptionId: string): boolean {
		const actor = this.fanout.get(peer)?.actor;
		return (
			typeof admissionId === "string" &&
			actor instanceof AdmissionRoutingActor &&
			(actor.subscriptions.get(subscriptionId) === admissionId ||
				([...actor.mirrorOwners.values()].includes(admissionId) &&
					this.recoveryCheckpoints
						.stream({ socketEpoch: this.socketEpochOf(peer) ?? "", sessionId: subscriptionId })
						?.routes.includes(admissionId) === true))
		);
	}
	registerAdmission(peer: string, admissionId: string, sessionId: string): void {
		const registered = this.fanout.get(peer);
		if (registered?.actor instanceof AdmissionRoutingActor) {
			registered.actor.admissions.add(admissionId);
			registered.actor.remember(sessionId, this.fanout.checkpoints, registered.socketEpoch);
		}
	}
	installAdmissionBaseline(peer: string, cursor: LegacyViewCursor, live: () => boolean): void {
		const actor = this.fanout.get(peer)?.actor;
		if (actor) actor.installBaseline(cursor, live);
		else cursor.release();
	}
	/** Internal S14 source identity; callers must establish the requesting token's scoped claim first. */
	recoveryLane(sessionId: string) {
		return this.fanout.acceptance.get(sessionId);
	}
	/** Whether an admission still routes a stream of this peer incarnation: what `reset_stream` resolves (#5274). */
	routesAdmission(socketEpoch: string, admissionId: string): boolean {
		return this.recoveryCheckpoints.routesAdmission(socketEpoch, admissionId);
	}
	/**
	 * RULING-117: a completed open becomes this socket's one route to its session. Answers how to end the open it
	 * replaces, only while that open still routes the session's stream; a retry of the same id replaces nothing.
	 */
	supersedeOpen(
		peer: string,
		sessionId: string,
		admissionId: string,
		end: () => Promise<void>,
	): (() => Promise<void>) | undefined {
		const registered = this.fanout.get(peer);
		const actor = registered?.actor;
		if (!registered || !(actor instanceof AdmissionRoutingActor)) return undefined;
		const previous = actor.opened.get(sessionId);
		actor.opened.set(sessionId, { admissionId, end });
		const stream = this.recoveryCheckpoints.stream({ socketEpoch: registered.socketEpoch, sessionId });
		return previous && previous.admissionId !== admissionId && stream?.routes.includes(previous.admissionId)
			? previous.end
			: undefined;
	}
	/**
	 * RULING-118: the socket stops holding the session (a detach), so its open's route retires and stops counting toward
	 * the admission cap. A detach made by a request naming that admission (`close_session`) retires it only after the
	 * request's reply is routed, so the reply and the records sealed before it keep the admission's tag.
	 */
	override detachConnectionFromSession(id: string, sessionId: string): void {
		const registered = this.fanout.get(id);
		const actor = registered?.actor;
		const opened = actor instanceof AdmissionRoutingActor ? actor.opened.get(sessionId) : undefined;
		const caller = registered && { socketEpoch: registered.socketEpoch, sessionId };
		if (caller && actor instanceof AdmissionRoutingActor && opened) actor.opened.delete(sessionId);
		// An open whose own release already retired its route (then detached) has nothing left to retire.
		if (caller && actor instanceof AdmissionRoutingActor && opened && this.routesStream(caller, opened.admissionId)) {
			const retire = () => {
				this.recoveryCheckpoints.retireRoute(caller, opened.admissionId);
				actor.admissions.delete(opened.admissionId);
			};
			const request = captureAdmissionReply();
			if (request?.id !== undefined && request.peer === id && request.admissionId === opened.admissionId)
				actor.deferRetire(request.id, retire);
			else retire();
		}
		super.detachConnectionFromSession(id, sessionId);
	}
	private routesStream(caller: { socketEpoch: string; sessionId: string }, admissionId: string): boolean {
		return this.recoveryCheckpoints.stream(caller)?.routes.includes(admissionId) === true;
	}
	/** Legacy views frozen for a peer's baseline and not yet released (R3.C6.4 accounting). */
	get openLegacyViews(): number {
		return this.fanout.replay.openCursors;
	}

	/** The checkpoint tokens frozen for peers' baselines and recoveries (S08a, R3.C1.5). */
	get recoveryCheckpoints(): RecoveryCheckpoints {
		return this.fanout.checkpoints;
	}

	/** The page requests over those tokens (S11b, R4.B3); undefined with the compact-updates flag off. */
	get recoveryPages(): RecoveryPageRequests | undefined {
		return this.fanout.pages;
	}

	/** The ordinary-event leases (S13, R4.B6); undefined with the compact-updates flag off. */
	get recoveryEvents(): EventLeases | undefined {
		return this.fanout.events;
	}

	/** The peer incarnation a registered connection is: what its tokens and cursors are bound to. */
	socketEpochOf(id: string): string | undefined {
		return this.fanout.get(id)?.socketEpoch;
	}
}
