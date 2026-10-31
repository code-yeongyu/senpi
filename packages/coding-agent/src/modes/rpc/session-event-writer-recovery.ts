import type { EventLeases } from "./compact-event-leases.ts";
import { AdmissionRoutingActor } from "./compact-admission-routing.ts";
import type { LegacyViewCursor } from "./legacy-view-cursor.ts";
import type { RecoveryPageRequests } from "./compact-recovery-requests.ts";
import type { RecoveryCheckpoints } from "./compact-recovery-state.ts";
import { SessionEventWriterLifecycle } from "./session-event-writer-lifecycle.ts";

/** The writer's recovery accessors (senpi#4272): legacy views, checkpoint tokens, page requests, peer epochs. */
export abstract class SessionEventWriterRecovery extends SessionEventWriterLifecycle {
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
