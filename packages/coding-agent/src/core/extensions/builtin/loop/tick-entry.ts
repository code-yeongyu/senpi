import type { LoopMode, TickDelivery } from "./tick-prompt.ts";
import type { DeliveryId, EpochMs, LoopId, LoopSentinel } from "./types.ts";

/** Custom entry type carrying one dispatched tick, used for attribution and folding. */
export const LOOP_TICK_ENTRY_TYPE = "loop-tick";

export interface LoopTickEntryData {
	readonly loopId: LoopId;
	readonly deliveryId: DeliveryId;
	readonly scheduledForAt: EpochMs;
	readonly mode: LoopMode;
	readonly delivery: TickDelivery;
	readonly sentinel?: LoopSentinel;
	/** Consecutive quiet dynamic iterations at the moment this tick was dispatched. */
	readonly noopStreak: number;
	/** True when this tick continues a quiet streak and should render folded. */
	readonly folded: boolean;
}
