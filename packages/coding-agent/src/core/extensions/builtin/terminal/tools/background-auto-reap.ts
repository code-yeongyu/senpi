/**
 * A session that runs on in the background (`run_in_background`, or a foreground command that auto-detached) is
 * announced to the host and, only when opted into (senpi#6201), stopped at a configured age. The reap runs here, where
 * the session's process group lives (this process, or the tool child), through `manager.stop`: the same TERM-then-KILL
 * stop `kill_bash` uses. Its one timer is unref'd and cleared when the session exits; with no opt-in none is armed.
 */
import { getAgentDir } from "../../../../../config.ts";
import { createSessionLogger } from "../../../../session-log.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import type { TerminalExitView, TerminalToolContext } from "./context.ts";

const MINUTE_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

/** The call's `auto_reap_minutes` wins over the setting; a whole number of minutes >= 1 reaps, 0 or less turns it off. */
export function resolveAutoReapMinutes(
	requested: number | undefined,
	configured: number | undefined,
): number | undefined {
	const value = requested ?? configured;
	if (value === undefined || !Number.isFinite(value)) return undefined;
	const minutes = Math.trunc(value);
	return minutes >= 1 ? minutes : undefined;
}

export interface BackgroundSessionStart {
	readonly description: string;
	readonly command: string;
	readonly startedAtMs: number;
	readonly autoReapMinutes: number | undefined;
}

export function backgroundStart(
	input: { readonly command: string; readonly description?: string; readonly auto_reap_minutes?: number },
	configuredMinutes: number | undefined,
	startedAtMs: number,
): BackgroundSessionStart {
	return {
		description: input.description ?? input.command,
		command: input.command,
		startedAtMs,
		autoReapMinutes: resolveAutoReapMinutes(input.auto_reap_minutes, configuredMinutes),
	};
}

function reapedView(runtime: TerminalExitView, minutes: number): TerminalExitView {
	return {
		exitResult: runtime.exitResult,
		autoReapedAfterMinutes: minutes,
		fullOutput: () => runtime.fullOutput(),
	};
}

export function trackBackgroundSession(
	ctx: TerminalToolContext,
	id: string,
	runtime: TerminalRuntimeSession,
	start: BackgroundSessionStart,
): void {
	ctx.onBackgroundStart?.(id, start.description, start.startedAtMs, start.command, start.autoReapMinutes);
	const minutes = start.autoReapMinutes;
	let reapedAfterMinutes: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = (deadlineMs: number): void => {
		timer = setTimeout(
			() => {
				timer = undefined;
				if (runtime.exited || minutes === undefined) return;
				if (Date.now() < deadlineMs) {
					arm(deadlineMs);
					return;
				}
				reapedAfterMinutes = minutes;
				ctx.manager.stop(id).catch((error: unknown) => {
					const logger = ctx.sessionLogger ?? createSessionLogger(getAgentDir());
					logger.warn("bash_auto_reap_failed", {
						bash_id: id,
						autoReapMinutes: minutes,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			},
			Math.min(Math.max(0, deadlineMs - Date.now()), MAX_TIMER_MS),
		);
		timer.unref?.();
	};
	if (minutes !== undefined && !runtime.exited) arm(start.startedAtMs + minutes * MINUTE_MS);
	if (minutes === undefined && !ctx.onBackgroundExit) return;
	runtime.session.onExit(() => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		ctx.onBackgroundExit?.(id, reapedAfterMinutes === undefined ? runtime : reapedView(runtime, reapedAfterMinutes));
	});
}
