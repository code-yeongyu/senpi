import type { EventLeases } from "./compact-event-leases.ts";
import { AdmissionRoutingActor } from "./compact-admission-routing.ts";
import type { LegacyViewCursor } from "./legacy-view-cursor.ts";
import type { RecoveryPageRequests } from "./compact-recovery-requests.ts";
import type { RecoveryCheckpoints } from "./compact-recovery-state.ts";
import { SessionEventWriterLifecycle } from "./session-event-writer-lifecycle.ts";

/** The writer's recovery accessors (senpi#4272): legacy views, checkpoint tokens, page requests, peer epochs. */
export abstract class SessionEventWriterRecovery extends SessionEventWriterLifecycle {
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
