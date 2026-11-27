import { debuglog } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import {
	isTerminalMonitorStateEvent,
	isWakeSourceStateEvent,
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../monitor-state-event.ts";
import { countRunningChildTasks } from "./child-tasks.ts";
import { SESSION_LIVENESS_CONNECT_EVENT, type SessionLiveness, type SessionLivenessReply } from "./connect.ts";
import {
	type HerdrState,
	type HerdrStateEvent,
	initialHerdrState,
	isHerdrBlockedEvent,
	openEndedMonitors,
	reduceHerdrState,
	selectHerdrReport,
} from "./state.ts";

const LOOP = { runs: "brain" } as const;
const CHILD_TASK_POLL_MS = 4000;

export interface SessionLivenessDependencies {
	/** Starts the child-record refresh; returns its stop. The default is an unref'd interval. */
	readonly schedulePoll?: (tick: () => void, intervalMs: number) => () => void;
	readonly debug?: (message: string) => void;
}

function scheduleUnrefInterval(tick: () => void, intervalMs: number): () => void {
	const handle = setInterval(tick, intervalMs);
	handle.unref();
	return () => clearInterval(handle);
}

/**
 * The session's one liveness fold: turn start and settle, `herdr:blocked`, the terminal monitor state, wake sources
 * and the child-task records on disk. The records are read only while a consumer is subscribed: once per subscribe,
 * on settle and on one poll that runs from the first subscriber to the last. It binds to the first `session_start`
 * and ends with that session's `session_shutdown`; a later `session_start` (a rebind) starts from a fresh fold, which
 * the inputs' owners refill by re-publishing at their own `session_start`. It registers first among the builtins so
 * it is listening before any of them does that (senpi#1146).
 */
export function createSessionLivenessWatcher(
	pi: Pick<ExtensionAPI, "on" | "events">,
	deps: SessionLivenessDependencies = {},
): void {
	const debug = deps.debug ?? debuglog("senpi:session-liveness");
	const schedulePoll = deps.schedulePoll ?? scheduleUnrefInterval;
	let bound: ExtensionContext | undefined;
	let state: HerdrState = initialHerdrState();
	let teardown: Array<() => void> = [];
	let stopPoll: (() => void) | undefined;
	const listeners = new Set<(state: HerdrState) => unknown>();
	const owns = (ctx: ExtensionContext) => bound !== undefined && bound.sessionManager === ctx.sessionManager;
	const fold = async (...events: HerdrStateEvent[]): Promise<void> => {
		for (const event of events) state = reduceHerdrState(state, event);
		await Promise.all([...listeners].map((listener) => listener(state)));
	};
	const children = (ctx: ExtensionContext): HerdrStateEvent => ({
		type: "children",
		count: countRunningChildTasks(ctx, debug),
	});
	const stopPolling = (): void => {
		stopPoll?.();
		stopPoll = undefined;
	};
	/** A new consumer reads a current child count; the ones already subscribed hear a change it brings. */
	const refreshFor = (ctx: ExtensionContext): void => {
		const before = state.childCount;
		state = reduceHerdrState(state, children(ctx));
		if (state.childCount !== before) void Promise.all([...listeners].map((listener) => listener(state)));
	};
	const liveness: SessionLiveness = {
		state: () => state,
		working: () => selectHerdrReport(state).state === "working",
		subscribe: (listener) => {
			const ctx = bound;
			if (ctx) refreshFor(ctx);
			listeners.add(listener);
			if (ctx && !stopPoll) stopPoll = schedulePoll(() => void fold(children(ctx)), CHILD_TASK_POLL_MS);
			return () => {
				if (listeners.delete(listener) && listeners.size === 0) stopPolling();
			};
		},
	};

	pi.on(
		"session_start",
		(_event, ctx) => {
			if (bound) return;
			bound = ctx;
			state = reduceHerdrState(initialHerdrState(), { type: "turn", active: !ctx.isIdle() });
			teardown = [
				pi.events.on(SESSION_LIVENESS_CONNECT_EVENT, (reply) => {
					if (typeof reply === "function") (reply as SessionLivenessReply)(liveness);
				}),
				pi.events.on("herdr:blocked", (data) => {
					if (isHerdrBlockedEvent(data)) return fold({ type: "blocked", ...data });
				}),
				pi.events.on(TERMINAL_MONITOR_STATE_EVENT, (data) => {
					if (!isTerminalMonitorStateEvent(data)) return;
					return fold({ type: "monitors", count: data.activeCount, openEnded: openEndedMonitors(data) });
				}),
				pi.events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
					if (isWakeSourceStateEvent(data))
						return fold({ type: "wake-source", source: data.source, count: data.activeCount });
				}),
			];
		},
		LOOP,
	);
	pi.on(
		"agent_start",
		(_event, ctx) => {
			if (owns(ctx)) return fold({ type: "turn", active: true });
		},
		LOOP,
	);
	pi.on(
		"agent_settled",
		(_event, ctx) => {
			if (!owns(ctx)) return;
			const turn: HerdrStateEvent = { type: "turn", active: !ctx.isIdle() };
			return listeners.size > 0 ? fold(turn, children(ctx)) : fold(turn);
		},
		LOOP,
	);
	pi.on(
		"session_shutdown",
		(_event, ctx) => {
			if (!owns(ctx)) return;
			for (const stop of teardown) stop();
			teardown = [];
			stopPolling();
			listeners.clear();
			bound = undefined;
		},
		LOOP,
	);
}
