/**
 * `schedule_wakeup` for a session whose loop keeps its wakes (a hosted loop's call on this machine, senpi#6754). The
 * /loop state is the session's document (its store file in the call's session directory), the attributed loop is read
 * from the carried branch, and the next iteration becomes a wake the loop arms as its own durable timer: no timer runs
 * here. When the wake fires the loop appends its tick entry and delivers the prompt as extension input, so the next
 * call is attributed to the same loop, as a local tick is.
 */
import type { SessionEntry } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { createLoopScheduler, type LoopClock, type LoopIdFactory, type LoopTimerPort } from "./scheduler.ts";
import { releaseLoopStore } from "./store.ts";
import { LOOP_TICK_ENTRY_TYPE, type LoopTickEntryData } from "./tick-entry.ts";
import type { ScheduleWakeupSchedulerPort } from "./tools.ts";
import type { LoopId, LoopState, LoopStoreRef } from "./types.ts";

export interface HostedWakeupDeps {
	readonly clock: LoopClock;
	readonly ids: LoopIdFactory;
	readonly storeRefOf: (ctx: ExtensionContext) => LoopStoreRef;
	readonly readState: (ref: LoopStoreRef) => Promise<LoopState | null>;
	readonly writeState: (ref: LoopStoreRef, state: LoopState) => Promise<void>;
}

/** No timer is armed on this machine: the loop arms the wake. */
const NO_TIMERS: LoopTimerPort = { arm: () => {}, cancel: () => {}, cancelAll: () => {} };

/** The loop of the newest tick on the branch, while only extension input (the tick's own prompt) followed it. */
function attributedLoopOf(branch: readonly SessionEntry[]): LoopId | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "user" && entry.inputSource !== "extension")
			return undefined;
		if (entry?.type !== "custom" || entry.customType !== LOOP_TICK_ENTRY_TYPE) continue;
		const loopId = (entry.data as Partial<LoopTickEntryData> | undefined)?.loopId;
		return typeof loopId === "string" ? loopId : undefined;
	}
	return undefined;
}

export const wakeIdOf = (loopId: LoopId): string => `loop:${loopId}`;

/** The scheduler port of one hosted call, or `undefined` where this process keeps the session's wakes itself. */
export function hostedWakeupScheduler(pi: ExtensionAPI, deps: HostedWakeupDeps) {
	return async (ctx: ExtensionContext): Promise<ScheduleWakeupSchedulerPort | undefined> => {
		const wakes = pi.session.sessionWakes();
		if (wakes === undefined) return undefined;
		const ref = deps.storeRefOf(ctx);
		const state = await deps.readState(ref).finally(() => releaseLoopStore(ref));
		const scheduler = createLoopScheduler({
			sessionId: ctx.sessionManager.getSessionId(),
			clock: deps.clock,
			timers: NO_TIMERS,
			ids: deps.ids,
			...(state === null ? {} : { initialState: state }),
		});
		const persist = () => deps.writeState(ref, scheduler.getState()).finally(() => releaseLoopStore(ref));
		const attributed = attributedLoopOf(ctx.sessionManager.getBranch());
		return {
			getWakeupTarget: () => {
				const entry = attributed === undefined ? undefined : scheduler.getState().entries[attributed];
				return entry === undefined || entry.phase === "ended" ? null : { kind: entry.kind, loopId: entry.id };
			},
			scheduleWakeup: async (request) => {
				const result = scheduler.onScheduleWakeup(request);
				if (!result.ok) throw new Error(`schedule_wakeup rejected: ${result.reason}`);
				await persist();
				const tick: LoopTickEntryData = {
					loopId: request.loopId,
					deliveryId: deps.ids.deliveryId(),
					scheduledForAt: result.dueAt,
					mode: "dynamic",
					delivery: "prompt",
					noopStreak: result.noopStreak,
					folded: result.noopStreak >= 2,
				};
				wakes.arm({
					id: wakeIdOf(request.loopId),
					source: "schedule_wakeup",
					dueAt: result.dueAt,
					prompt: request.prompt,
					createdAt: deps.clock.now(),
					entry: { customType: LOOP_TICK_ENTRY_TYPE, data: tick },
				});
				return {
					wakeupId: result.wakeupId,
					...(result.replacedWakeupId === undefined ? {} : { replacedWakeupId: result.replacedWakeupId }),
					dueAt: result.dueAt,
					noopStreak: result.noopStreak,
				};
			},
			stopDynamicLoop: async (request) => {
				scheduler.stop(request.loopId, "model-stop");
				await persist();
				wakes.cancel(wakeIdOf(request.loopId));
				return { endedAt: deps.clock.now() };
			},
		};
	};
}
