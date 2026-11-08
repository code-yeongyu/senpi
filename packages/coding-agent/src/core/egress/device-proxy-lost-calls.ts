/**
 * Pacing of the 4.5 `unknown` reissue (row CK9; security review H1). A hand that has lost a call (`result` answers
 * `unknown`) makes the brain supersede the row and reissue the stored request, and a hand that loses every call would
 * otherwise drive an unbounded supersede/W4 cycle through the session's durable store. Per (step, device): the first
 * lost call is reissued at once, the next one only after the key backoff (5 s doubling to 5 min), and after
 * `MAX_AUTOMATIC_REISSUES` automatic reissues the step waits for the user's choice "re-run this step or select another
 * device" (the cap mirrors the two-mismatch cap of 4.2). Callback-stream steps already wait for that choice before
 * every reissue (4.5), so for them only the backoff applies.
 */
import type { DeviceId } from "@earendil-works/pi-agent-core";
import { type EgressClock, nextKeyBackoffMs, type StepWaits, type WaitConditionSource } from "./device-proxy-waits.ts";

const MAX_AUTOMATIC_REISSUES = 2;

export interface LostCallPacer {
	/** Called after a lost call was superseded and before `attempt` (the reissue) is dispatched. */
	beforeReissue(deviceId: DeviceId, attempt: number): Promise<void>;
}

export interface LostCallPacing {
	readonly stepId: string;
	readonly waits: StepWaits;
	readonly conditions: WaitConditionSource;
	readonly clock: EgressClock;
	readonly signal: AbortSignal;
	/** False for callback-stream steps, whose every reissue already waits for the user's choice. */
	readonly askUser: boolean;
}

export function lostCallPacer(pacing: LostCallPacing): LostCallPacer {
	const { stepId, waits, conditions, clock, signal } = pacing;
	const lost = new Map<DeviceId, number>();
	let backoff: number | undefined;
	return {
		async beforeReissue(deviceId, attempt) {
			const reissues = lost.get(deviceId) ?? 0;
			if (pacing.askUser && reissues >= MAX_AUTOMATIC_REISSUES) {
				lost.set(deviceId, 0);
				const waitFor = [{ kind: "user-choice", choiceId: `${stepId}:${attempt}` }] as const;
				const steer = `${deviceId} lost this step ${reissues + 1} times: re-run it or select another device`;
				await waits.hold({ reason: "result-pending", steer, waitFor }, conditions.until(waitFor, signal));
				return;
			}
			lost.set(deviceId, reissues + 1);
			if (reissues === 0) return;
			backoff = nextKeyBackoffMs(backoff);
			const steer = `${deviceId} lost this step; reissuing it`;
			await waits.hold({ reason: "result-pending", steer, waitFor: [] }, clock.sleep(backoff, signal));
		},
	};
}
