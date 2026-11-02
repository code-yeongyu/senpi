import { AdmissionRoutingActor } from "./compact-admission-routing.ts";
import type { CheckpointToken } from "./compact-recovery-types.ts";
import { COMPACT_EVENTS_CAPABILITY } from "./custom-capability.ts";
import type { SessionEventFanout } from "./session-event-fanout.ts";
import type { SessionStatusStream } from "./session-status-stream.ts";

/** One minimal delivered-state frontier per physical stream, never a reducer or an omitted-record log. */
export class CompactRequiredStreams {
	private readonly fanout: SessionEventFanout;
	private readonly status: SessionStatusStream;
	private readonly states = new WeakMap<
		AdmissionRoutingActor,
		Map<string, { epoch: string; dirty: boolean; seed?: CheckpointToken }>
	>();

	constructor(fanout: SessionEventFanout, status: SessionStatusStream) {
		this.fanout = fanout;
		this.status = status;
	}

	sessions(peer: string): readonly string[] {
		return this.status.requiredSessions(peer);
	}

	routes(peer: string, sessionId: string, type: string): readonly string[] {
		const registered = this.fanout.get(peer);
		const actor = registered?.actor;
		if (!(actor instanceof AdmissionRoutingActor) || !registered) return [];
		return [
			...new Set([
				...(
					this.fanout.checkpoints.stream({ socketEpoch: registered.socketEpoch, sessionId })?.routes ?? []
				).filter((id) => actor.admissions.has(id)),
				...this.status.mirrorAdmissions(peer, sessionId, type),
			]),
		];
	}

	prepare(sessionId: string, record?: object): void {
		const lane = this.fanout.acceptance.get(sessionId);
		if (!lane || lane.retired) return;
		for (const peer of this.fanout.connectionIds()) {
			if (!this.fanout.connectionHas(peer, COMPACT_EVENTS_CAPABILITY)) continue;
			const registered = this.fanout.get(peer);
			const actor = registered?.actor;
			if (!(actor instanceof AdmissionRoutingActor) || !registered) continue;
			const routes = this.status.requiredAdmissions(peer, sessionId);
			const caller = { socketEpoch: registered.socketEpoch, sessionId };
			for (const admissionId of routes) {
				if (this.fanout.checkpoints.stream(caller)?.routes.includes(admissionId)) continue;
				const frozen = this.fanout.checkpoints.freeze(
					{ ...caller, peer, admissionId, routeKind: "mirror" },
					lane,
					true,
				);
				if (!frozen.ok) {
					registered.connection.close?.();
					continue;
				}
			}
			const stream = this.fanout.checkpoints.stream(caller);
			if (!stream?.routes.length) continue;
			const states = this.states.get(actor) ?? new Map();
			this.states.set(actor, states);
			let state = states.get(sessionId);
			if (state?.epoch !== lane.sessionEpoch) {
				state = { epoch: lane.sessionEpoch, dirty: false };
				states.set(sessionId, state);
				state.seed = this.fanout.checkpoints
					.tokens()
					.find((t) => t.admission.socketEpoch === caller.socketEpoch && t.admission.sessionId === sessionId);
			}
			if (!record) continue;
			const type = String(Reflect.get(record, "type"));
			const selected =
				stream.routes.some((id) => actor.admissions.has(id)) ||
				this.status.mirrorAdmissions(peer, sessionId, type).length > 0;
			if (!selected) {
				state.dirty = true;
				continue;
			}
			if (state.dirty) {
				const frozen = this.fanout.checkpoints.freeze(
					{ ...caller, peer, admissionId: stream.routes[0], routeKind: routes.length ? "mirror" : "ordinary" },
					lane,
				);
				if (!frozen.ok) {
					registered.connection.close?.();
					continue;
				}
				state.seed = frozen.value.token;
				state.dirty = false;
			}
		}
	}

	takeSeed(peer: string, sessionId: string): CheckpointToken | undefined {
		const actor = this.fanout.get(peer)?.actor;
		const state = actor instanceof AdmissionRoutingActor ? this.states.get(actor)?.get(sessionId) : undefined;
		const seed = state?.seed;
		if (state) state.seed = undefined;
		return seed;
	}

	forgetSession(sessionId: string): void {
		for (const peer of this.fanout.connectionIds()) {
			const actor = this.fanout.get(peer)?.actor;
			if (actor instanceof AdmissionRoutingActor) this.states.get(actor)?.delete(sessionId);
		}
	}
}
