import { randomUUID } from "node:crypto";
import type {
	RelocationRequestResult,
	RelocationTarget,
	SessionRelocationHost,
} from "../../core/session-relocation.ts";
import type { RelocationRequestEffect } from "../../core/hand/session-state-effects.ts";
import type { SessionWake, SessionWakeChange, SessionWakePort } from "../../core/session-wakes.ts";

export type { RelocationRequestEffect };

/** The relocation offer a loop carries with a call: the user's computers its host offers. */
export interface CarriedRelocation {
	readonly targets: readonly RelocationTarget[];
}

/**
 * Relocation for a hand's call, answered from what the loop carried: it lists the carried targets and accepts a move to
 * a listed online one as a request the loop applies when the turn ends (as a local host schedules it); a move to any
 * other target is refused here, before the loop sees it.
 */
export function carriedRelocationHost(
	offer: CarriedRelocation,
	request: (effect: RelocationRequestEffect) => void,
): SessionRelocationHost {
	return {
		offered: () => true,
		targets: async () => ({ status: "listed", targets: offer.targets }),
		async request({ target, reason }): Promise<RelocationRequestResult> {
			const known = offer.targets.find((candidate) => candidate.name === target);
			if (known === undefined)
				return { status: "refused", reason: "unknown_target", detail: `no computer named ${target} is offered` };
			if (!known.online) return { status: "refused", reason: "target_offline", detail: `${target} is offline` };
			const moveId = randomUUID();
			request({ target, reason, moveId });
			return { status: "scheduled", target, moveId };
		},
	};
}

/** The loop's wakes as a call sees them: the carried pending ones with the call's own changes applied, in order. */
export function carriedWakePort(carried: readonly SessionWake[], changes: SessionWakeChange[]): SessionWakePort {
	const pending = (): SessionWake[] => {
		let wakes = [...carried];
		for (const change of changes) {
			const id = change.op === "arm" ? change.wake.id : change.id;
			wakes = wakes.filter((wake) => wake.id !== id);
			if (change.op === "arm") wakes.push(change.wake);
		}
		return wakes;
	};
	return {
		pending,
		arm: (wake) => {
			changes.push({ op: "arm", wake: { ...wake } });
		},
		cancel: (id) => {
			if (!pending().some((wake) => wake.id === id)) return false;
			changes.push({ op: "cancel", id });
			return true;
		},
	};
}
