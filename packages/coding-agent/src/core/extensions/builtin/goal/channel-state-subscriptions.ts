import type { ExtensionAPI } from "../../types.ts";
import {
	CONTINUATION_HOLD_STATE_EVENT,
	isContinuationHoldStateEvent,
	isTerminalMonitorStateEvent,
	isWakeSourceStateEvent,
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../monitor-state-event.ts";

type GoalChannelEvents = NonNullable<ExtensionAPI["events"]>;

interface GoalChannelCallbacks {
	readonly onWakeSource: (source: string, activeCount: number) => void;
	readonly onContinuationHold: (source: string, active: boolean) => void;
}

export function subscribeGoalChannelState(
	events: GoalChannelEvents,
	callbacks: GoalChannelCallbacks,
): Array<() => void> {
	return [
		events.on(TERMINAL_MONITOR_STATE_EVENT, (data) => {
			if (isTerminalMonitorStateEvent(data)) callbacks.onWakeSource("terminal-monitors", data.activeCount);
		}),
		events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
			if (isWakeSourceStateEvent(data)) callbacks.onWakeSource(data.source, data.activeCount);
		}),
		events.on(CONTINUATION_HOLD_STATE_EVENT, (data) => {
			if (isContinuationHoldStateEvent(data)) callbacks.onContinuationHold(data.source, data.active);
		}),
	];
}
