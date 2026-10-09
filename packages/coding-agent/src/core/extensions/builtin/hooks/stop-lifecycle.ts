import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isStaleExtensionContextError } from "../goal/stale-context.ts";
import { isWakeSourceStateEvent, WAKE_SOURCE_STATE_EVENT } from "../monitor-state-event.ts";
import { dispatchHookEvent } from "./dispatcher.ts";
import { applyStopHookResult, buildStopHookInput, createStopTurnTracker } from "./stop-adapter.ts";
import type { HookInputWire, HookTrustState, ParsedHookConfig } from "./types.ts";

/**
 * Background work usually clears its wake source and wakes the session in the same
 * completion handler, in either order. A drained live set therefore waits this long for
 * the wake turn before Stop reports the session quiet; a turn that starts first cancels it.
 */
export const STOP_DRAIN_GRACE_MS = 2_000;

/** A pending question is the user's turn, which is exactly what Stop reports. */
const USER_TURN_WAKE_SOURCE = "ask-user";

type PendingStop = {
	readonly ctx: ExtensionContext;
	readonly input: HookInputWire;
};

export type StopLifecycleDeps = {
	readonly refreshState: (ctx: ExtensionContext) => {
		readonly parsed: ParsedHookConfig;
		readonly trust: HookTrustState;
	};
};

export type StopLifecycle = {
	readonly resetTurn: () => void;
};

/**
 * Dispatches the Stop hook when the session actually stops. A turn that ends while a
 * background wake source is live (subagent task, DAG run, terminal monitor, background bash
 * session, detached eval cell, loop-guard hold) has handed the session to work that wakes it
 * again, so its Stop waits: the wake turn's own end reports it, or the drain does when the
 * work clears without waking the session.
 */
export function registerStopLifecycle(pi: ExtensionAPI, deps: StopLifecycleDeps): StopLifecycle {
	const turnTracker = createStopTurnTracker();
	const backgroundWork = new Map<string, number>();
	let pending: PendingStop | undefined;
	let drainTimer: ReturnType<typeof setTimeout> | undefined;

	async function dispatchStop({ ctx, input }: PendingStop): Promise<void> {
		const state = deps.refreshState(ctx);
		const result = await dispatchHookEvent({
			cwd: ctx.cwd,
			handlers: state.parsed.executableHandlers,
			input,
			signal: ctx.signal,
			trustOptions: { platform: process.platform },
			trustState: state.trust,
		});
		await applyStopHookResult(pi, ctx, result, turnTracker.turnKey(ctx));
	}

	function clearDrainTimer(): void {
		if (drainTimer === undefined) return;
		clearTimeout(drainTimer);
		drainTimer = undefined;
	}

	function dropPending(): void {
		clearDrainTimer();
		pending = undefined;
	}

	function dispatchPendingIfQuiet(): void {
		drainTimer = undefined;
		const stop = pending;
		if (stop === undefined || backgroundWork.size > 0) return;
		// A wake turn that is already running or queued reports its own Stop when it ends.
		if (!stop.ctx.isIdle() || stop.ctx.hasPendingMessages()) return;
		pending = undefined;
		dispatchStop(stop).catch((error: unknown) => {
			if (isStaleExtensionContextError(error)) return;
			stop.ctx.ui.notify(
				`Stop hook dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		});
	}

	pi.events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
		if (!isWakeSourceStateEvent(data) || data.source === USER_TURN_WAKE_SOURCE) return;
		if (data.activeCount > 0) backgroundWork.set(data.source, data.activeCount);
		else backgroundWork.delete(data.source);
		clearDrainTimer();
		if (backgroundWork.size > 0 || pending === undefined) return;
		drainTimer = setTimeout(dispatchPendingIfQuiet, STOP_DRAIN_GRACE_MS);
		drainTimer.unref();
	});

	pi.on("agent_end", async (event, ctx) => {
		const stop = { ctx, input: buildStopHookInput(event, ctx) };
		if (backgroundWork.size > 0) {
			pending = stop;
			return;
		}
		dropPending();
		await dispatchStop(stop);
	});

	pi.on("agent_start", () => dropPending());
	pi.on("session_shutdown", () => dropPending());

	return { resetTurn: () => turnTracker.reset() };
}
