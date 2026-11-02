/**
 * `/loop` command handler: native argument parsing and the user-facing surfaces.
 *
 * Parsing is pure native code (`parse.ts`) - the command never expands into a
 * model-facing parsing prompt. Starting a loop always goes through the extension's
 * controller, which persists and arms the schedule BEFORE dispatching the first tick,
 * so a failed first turn can never silently lose the job.
 *
 * Headless rejection: print/json modes have no interactive session, so the command
 * refuses with a one-line message and arms nothing.
 */

import type { ExtensionCommandContext } from "../../types.ts";
import type { LoopController, LoopCreateOk } from "./index.ts";
import { type LoopTarget, parseLoopArgs } from "./parse.ts";
import type { CronEntry, LoopId, LoopState } from "./types.ts";

export const LOOP_ARGUMENT_HINT = "[interval] [prompt] | stop [id|all] | status | pause | resume";
export const LOOP_COMMAND_DESCRIPTION =
	"Repeat a prompt on a fixed interval or a self-paced schedule (e.g. /loop 5m check the deploy)";

const LOOP_SUBCOMMANDS = ["stop", "status", "pause", "resume"] as const;

const LOOP_HEADLESS_REJECTION =
	"/loop needs an interactive session; it is not available in print mode, so nothing was armed.";

export interface LoopCommandDeps {
	readonly controller: LoopController;
}

/** Headless modes: single-shot output streams with no interactive transcript. */
function isHeadlessMode(mode: ExtensionCommandContext["mode"]): boolean {
	return mode === "print" || mode === "json";
}

/**
 * Argument completions for the subcommand keywords, modeled on the todo extension's
 * verb completions: prefix-filtered, `null` when nothing matches.
 */
export function completeLoopArguments(argumentPrefix: string): Array<{ value: string; label: string }> | null {
	const prefix = argumentPrefix.trim().toLowerCase();
	const matches = LOOP_SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(prefix));
	if (matches.length === 0) return null;
	return matches.map((subcommand) => ({ value: subcommand, label: subcommand }));
}

function formatExpiry(expiresAt: number | undefined): string {
	return expiresAt === undefined ? "after 7 days" : new Date(expiresAt).toISOString();
}

/** Fixed-loop confirmation: id, cron, effective cadence, rounding notice, expiry, stop command. */
export function formatFixedLoopConfirmation(outcome: LoopCreateOk, requestedRaw: string): string {
	const cadence = outcome.effectiveCadence ?? "on schedule";
	const parenthetical =
		outcome.roundingNotice === undefined ? `every ${cadence}` : `every ${cadence}; requested ${requestedRaw}`;
	const lines = [`Loop ${outcome.loopId} scheduled as \`${outcome.cronExpression ?? ""}\` (${parenthetical}).`];
	if (outcome.roundingNotice !== undefined) lines.push(outcome.roundingNotice);
	lines.push(`It expires automatically at ${formatExpiry(outcome.expiresAt)} (7 days).`);
	lines.push(`Stop it with \`/loop stop ${outcome.loopId}\`.`);
	lines.push("Running the first tick now.");
	return lines.join("\n");
}

/** Dynamic-loop confirmation, including the supersession line when one replaced another. */
export function formatDynamicLoopConfirmation(outcome: LoopCreateOk): string {
	const lines = [
		`Loop ${outcome.loopId} started in dynamic mode: the model paces each iteration with \`schedule_wakeup\`.`,
	];
	if (outcome.supersededLoopId !== undefined) lines.push(`Superseded dynamic loop ${outcome.supersededLoopId}.`);
	lines.push(`It expires automatically at ${formatExpiry(outcome.expiresAt)} (7 days).`);
	lines.push(`Stop it with \`/loop stop ${outcome.loopId}\` or a \`schedule_wakeup\` call with \`{ stop: true }\`.`);
	lines.push("Running the first iteration now.");
	return lines.join("\n");
}

/** Bare-invocation confirmation; the mode comes from the entry the controller created. */
export function formatBareLoopConfirmation(outcome: LoopCreateOk, entry: CronEntry | undefined): string {
	const mode = entry?.kind === "fixed" ? `fixed, every ${entry.effectiveInterval.human}` : "dynamic pacing";
	const lines = [`Loop ${outcome.loopId} started (${mode}).`];
	lines.push(`It expires automatically at ${formatExpiry(outcome.expiresAt)} (7 days).`);
	lines.push(`Stop it with \`/loop stop ${outcome.loopId}\`.`);
	lines.push("Running the first tick now.");
	return lines.join("\n");
}

function describeLoopEntry(entry: CronEntry): string {
	const mode =
		entry.kind === "fixed"
			? `fixed, \`${entry.cronExpression}\` (every ${entry.effectiveInterval.human})`
			: "dynamic";
	const paused = entry.phase === "suspended" ? " · paused" : "";
	return `- ${entry.id} (${mode}) · expires ${formatExpiry(entry.expiresAt)}${paused}`;
}

/**
 * The `/loop status` listing: the live status line (countdown + stop affordance) plus
 * one row per active loop.
 */
export function formatLoopStatusListing(statusLine: string | undefined, state: LoopState): string {
	const active = Object.values(state.entries).filter((entry) => entry.phase !== "ended");
	if (active.length === 0) return "No active loops.";
	const lines = statusLine === undefined ? [] : [statusLine];
	lines.push("Active loops:");
	for (const entry of active) lines.push(describeLoopEntry(entry));
	return lines.join("\n");
}

function activeLoopIds(state: LoopState): readonly LoopId[] {
	return Object.values(state.entries)
		.filter((entry) => entry.phase !== "ended")
		.map((entry) => entry.id);
}

type TargetResolution =
	| { readonly action: "apply"; readonly value: LoopId | "all" }
	| { readonly action: "none" }
	| { readonly action: "ambiguous"; readonly ids: readonly LoopId[] };

/**
 * Resolves a stop/pause/resume target. An implicit target names the single active loop;
 * with several armed loops the command must not guess, so it asks for disambiguation.
 */
function resolveCommandTarget(target: LoopTarget, state: LoopState): TargetResolution {
	if (target.type === "all") return { action: "apply", value: "all" };
	if (target.type === "id") return { action: "apply", value: target.id };
	const ids = activeLoopIds(state);
	if (ids.length === 0) return { action: "none" };
	if (ids.length === 1) return { action: "apply", value: ids[0] };
	return { action: "ambiguous", ids };
}

function notifyAmbiguous(
	ctx: ExtensionCommandContext,
	verb: "stop" | "pause" | "resume",
	ids: readonly LoopId[],
): void {
	const lines = ["Multiple loops are active:", ...ids.map((id) => `- ${id}`)];
	lines.push(`Use \`/loop ${verb} <id>\` or \`/loop ${verb} all\`.`);
	ctx.ui.notify(lines.join("\n"), "warning");
}

function notifyUnknownId(ctx: ExtensionCommandContext, id: string, state: LoopState): void {
	const ids = activeLoopIds(state);
	const lines = [`No active loop with id "${id}".`];
	if (ids.length > 0) lines.push(`Active loops: ${ids.join(", ")}.`);
	ctx.ui.notify(lines.join("\n"), "warning");
}

async function runStop(ctx: ExtensionCommandContext, deps: LoopCommandDeps, target: LoopTarget): Promise<void> {
	const resolution = resolveCommandTarget(target, deps.controller.getState());
	if (resolution.action === "none") {
		ctx.ui.notify("No active loops.", "warning");
		return;
	}
	if (resolution.action === "ambiguous") {
		notifyAmbiguous(ctx, "stop", resolution.ids);
		return;
	}
	const affected = await deps.controller.stop(resolution.value, "user-stop");
	if (resolution.value === "all") {
		if (affected.length === 0) {
			ctx.ui.notify("No active loops.", "warning");
			return;
		}
		const noun = affected.length === 1 ? "loop" : "loops";
		ctx.ui.notify(`Stopped ${affected.length} ${noun}: ${affected.join(", ")}.`, "info");
		return;
	}
	if (affected.length === 0) {
		notifyUnknownId(ctx, resolution.value, deps.controller.getState());
		return;
	}
	ctx.ui.notify(`Stopped loop ${resolution.value}.`, "info");
}

async function runPause(ctx: ExtensionCommandContext, deps: LoopCommandDeps, target: LoopTarget): Promise<void> {
	const resolution = resolveCommandTarget(target, deps.controller.getState());
	if (resolution.action === "none") {
		ctx.ui.notify("No active loops.", "warning");
		return;
	}
	if (resolution.action === "ambiguous") {
		notifyAmbiguous(ctx, "pause", resolution.ids);
		return;
	}
	const affected = await deps.controller.pause(resolution.value);
	if (resolution.value === "all") {
		if (affected.length === 0) {
			ctx.ui.notify("No pausable loops.", "warning");
			return;
		}
		const noun = affected.length === 1 ? "loop" : "loops";
		ctx.ui.notify(`Paused ${affected.length} ${noun}: ${affected.join(", ")}.`, "info");
		return;
	}
	if (affected.length === 0) {
		ctx.ui.notify(`Loop ${resolution.value} is not pausable (already paused or ended).`, "warning");
		return;
	}
	ctx.ui.notify(`Paused loop ${resolution.value}.`, "info");
}

async function runResume(ctx: ExtensionCommandContext, deps: LoopCommandDeps, target: LoopTarget): Promise<void> {
	const resolution = resolveCommandTarget(target, deps.controller.getState());
	if (resolution.action === "none") {
		ctx.ui.notify("No active loops.", "warning");
		return;
	}
	if (resolution.action === "ambiguous") {
		notifyAmbiguous(ctx, "resume", resolution.ids);
		return;
	}
	const affected = await deps.controller.resume(resolution.value);
	if (resolution.value === "all") {
		if (affected.length === 0) {
			ctx.ui.notify("No paused loops to resume.", "warning");
			return;
		}
		const noun = affected.length === 1 ? "loop" : "loops";
		ctx.ui.notify(`Resumed ${affected.length} ${noun}: ${affected.join(", ")}.`, "info");
		return;
	}
	if (affected.length === 0) {
		ctx.ui.notify(`Loop ${resolution.value} is not paused.`, "warning");
		return;
	}
	ctx.ui.notify(`Resumed loop ${resolution.value}.`, "info");
}

async function reportCreateOutcome(
	ctx: ExtensionCommandContext,
	deps: LoopCommandDeps,
	outcome: LoopCreateOk,
	format: (entry: CronEntry | undefined) => string,
): Promise<void> {
	const entry = deps.controller.getState().entries[outcome.loopId];
	ctx.ui.notify(format(entry), "info");
}

/** The `/loop` command entry point. */
export async function runLoopCommand(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	deps: LoopCommandDeps,
): Promise<void> {
	if (isHeadlessMode(ctx.mode)) {
		ctx.ui.notify(LOOP_HEADLESS_REJECTION, "warning");
		// Headless hosts install a no-op UI context, so `notify` alone leaves the refusal
		// invisible (empty output, exit 0). Write to stderr as well so the message is actually
		// seen; real stdout stays reserved for `-p` result data.
		process.stderr.write(`${LOOP_HEADLESS_REJECTION}\n`);
		return;
	}

	const parsed = parseLoopArgs(rawArgs);
	try {
		switch (parsed.kind) {
			case "invalid": {
				ctx.ui.notify(parsed.usage, "warning");
				return;
			}
			case "fixed": {
				const outcome = await deps.controller.startFixed({
					originalArgs: parsed.originalArgs,
					prompt: parsed.prompt,
					requestedInterval: parsed.interval,
				});
				if (!outcome.ok) {
					ctx.ui.notify(outcome.message, "error");
					return;
				}
				await reportCreateOutcome(ctx, deps, outcome, () =>
					formatFixedLoopConfirmation(outcome, parsed.interval.raw),
				);
				return;
			}
			case "dynamic": {
				const outcome = await deps.controller.startDynamic({
					originalArgs: parsed.originalArgs,
					prompt: parsed.prompt,
				});
				if (!outcome.ok) {
					ctx.ui.notify(outcome.message, "error");
					return;
				}
				await reportCreateOutcome(ctx, deps, outcome, () => formatDynamicLoopConfirmation(outcome));
				return;
			}
			case "bare": {
				const outcome = await deps.controller.startBare({
					originalArgs: parsed.originalArgs,
					...(parsed.interval === undefined ? {} : { interval: parsed.interval }),
				});
				if (!outcome.ok) {
					ctx.ui.notify(outcome.message, "error");
					return;
				}
				await reportCreateOutcome(ctx, deps, outcome, (entry) => formatBareLoopConfirmation(outcome, entry));
				return;
			}
			case "stop": {
				await runStop(ctx, deps, parsed.target);
				return;
			}
			case "pause": {
				await runPause(ctx, deps, parsed.target);
				return;
			}
			case "resume": {
				await runResume(ctx, deps, parsed.target);
				return;
			}
			case "status": {
				ctx.ui.notify(formatLoopStatusListing(deps.controller.statusLine(), deps.controller.getState()), "info");
				return;
			}
		}
	} catch (error) {
		// A failed command must surface, not vanish: notify and stop.
		ctx.ui.notify(`/loop command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
