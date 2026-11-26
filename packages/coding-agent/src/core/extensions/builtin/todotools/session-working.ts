import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import {
	type HerdrStateEvent,
	initialHerdrState,
	isHerdrBlockedEvent,
	openEndedMonitors,
	reduceHerdrState,
	selectHerdrReport,
} from "../herdr/herdr-state.ts";
import {
	isTerminalMonitorStateEvent,
	isWakeSourceStateEvent,
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../monitor-state-event.ts";

const LOOP = { runs: "brain" } as const;

/**
 * Whether the session is working (a turn is active or bounded background work is live), folded by the herdr pane
 * report's own rule from the events that report listens to (senpi#1146). The pane report also counts task records
 * on disk, which this does not.
 * `onChange` runs when the answer flips; the first read of a session comes from its `session_start`.
 */
export function watchSessionWorking(pi: ExtensionAPI, onChange: (ctx: ExtensionContext) => void): () => boolean {
	let state = initialHerdrState();
	let boundCtx: ExtensionContext | undefined;
	let subscriptions: Array<() => void> = [];
	const isWorking = (): boolean => selectHerdrReport(state).state === "working";
	const apply = (event: HerdrStateEvent): void => {
		const before = isWorking();
		state = reduceHerdrState(state, event);
		if (boundCtx && isWorking() !== before) onChange(boundCtx);
	};
	const unsubscribe = (): void => {
		for (const stop of subscriptions) stop();
		subscriptions = [];
	};

	pi.on(
		"session_start",
		(_event, ctx) => {
			unsubscribe();
			boundCtx = ctx;
			state = reduceHerdrState(initialHerdrState(), { type: "turn", active: !ctx.isIdle() });
			subscriptions = [
				pi.events.on("herdr:blocked", (data) => {
					if (isHerdrBlockedEvent(data)) apply({ type: "blocked", ...data });
				}),
				pi.events.on(TERMINAL_MONITOR_STATE_EVENT, (data) => {
					if (!isTerminalMonitorStateEvent(data)) return;
					apply({ type: "monitors", count: data.activeCount, openEnded: openEndedMonitors(data) });
				}),
				pi.events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
					if (isWakeSourceStateEvent(data))
						apply({ type: "wake-source", source: data.source, count: data.activeCount });
				}),
			];
		},
		LOOP,
	);
	pi.on(
		"agent_start",
		(_event, ctx) => {
			boundCtx = ctx;
			apply({ type: "turn", active: true });
		},
		LOOP,
	);
	pi.on(
		"agent_settled",
		(_event, ctx) => {
			boundCtx = ctx;
			apply({ type: "turn", active: !ctx.isIdle() });
		},
		LOOP,
	);
	pi.on("session_shutdown", unsubscribe, LOOP);
	return isWorking;
}
