import { annotateShellTrust } from "../../../../engine-trust/shell-trust.ts";
import type { ExtensionContext } from "../../types.ts";
import type { TerminalBackgroundAgeEvent } from "../monitor-state-event.ts";
import { withTerminalContext } from "./context-lifetime.ts";
import { sanitizeTerminalOutput } from "./output-format.ts";
import type { NotifyMode } from "./settings.ts";
import type { TerminalExitView } from "./tools/context.ts";
import { describeExit } from "./tools/spawn.ts";

/** Modes that never wake the agent: one-shot, non-interactive runs. */
export const NON_INTERACTIVE_MODES = new Set(["print", "json"]);
export const TERMINAL_NOTIFICATION_CUSTOM_TYPE = "senpi-terminal:notification";

export interface TerminalNotifierDeps {
	/** Deliver a model-visible notification without rendering synthetic user input. */
	readonly sendMessage: (
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" },
	) => void;
	readonly getContext: () => ExtensionContext | undefined;
	readonly getMode: () => NotifyMode;
}

/** Max chars of sanitized final output embedded in a completion notification. */
export const NOTICE_TAIL_MAX_CHARS = 2000;

export interface TerminalNotificationDelivery {
	readonly send: (content: string, options?: { readonly forceWake?: boolean; readonly details?: unknown }) => void;
}

/** Shared terminal-notification guard and notify-mode mapping. */
export function getTerminalNotificationDelivery(
	deps: TerminalNotifierDeps,
	customType = TERMINAL_NOTIFICATION_CUSTOM_TYPE,
): TerminalNotificationDelivery | undefined {
	const mode = deps.getMode();
	if (mode === "off") return undefined;
	const ctx = deps.getContext();
	if (!ctx || NON_INTERACTIVE_MODES.has(ctx.mode) || !ctx.model) return undefined;
	return {
		send: (content, options) =>
			deps.sendMessage(
				{
					customType,
					content,
					display: false,
					...(options?.details === undefined ? {} : { details: options.details }),
				},
				{
					triggerTurn: true,
					deliverAs: mode === "wake" || options?.forceWake === true ? "steer" : "followUp",
				},
			),
	};
}

function minutes(count: number): string {
	return `${count} minute${count === 1 ? "" : "s"}`;
}

function killCall(id: string): string {
	return `kill_bash({ bash_id: "${id}" })`;
}

/** One plain sentence (or two) for the TUI and the model: which session, how old, and how it stops. */
export function describeBackgroundAge(event: TerminalBackgroundAgeEvent): string {
	const label =
		event.command === undefined || event.command === event.description
			? event.description
			: `${event.description}: ${event.command}`;
	const session = `Background terminal session ${event.id} (${label})`;
	if (event.kind === "reaped") {
		return `${session} was stopped automatically after ${minutes(event.autoReapMinutes ?? event.ageMinutes)} (auto-reap).`;
	}
	if (event.kind === "reap_failed") {
		return `${session} is still running: auto-reap at ${minutes(event.autoReapMinutes ?? event.ageMinutes)} failed (${event.reason ?? "unknown reason"}) and will not retry; stop it with ${killCall(event.id)} if it is no longer needed.`;
	}
	const reap =
		event.autoReapMinutes === null
			? "Nothing stops it automatically"
			: `Auto-reap stops it at ${minutes(event.autoReapMinutes)}`;
	return `${session} has been running for ${minutes(event.ageMinutes)}. ${reap}; stop it now with ${killCall(event.id)} if it is no longer needed.`;
}

function buildNotice(id: string, runtime: TerminalExitView, trustText: string | undefined): string {
	const reaped = runtime.autoReapedAfterMinutes;
	const reapText =
		reaped === undefined
			? ""
			: ` It was stopped automatically after ${minutes(reaped)} (auto-reap: the auto_reap_minutes parameter or the terminal.backgroundAutoReapMinutes setting).`;
	const status = describeExit(runtime) ?? "exited";
	const code = runtime.exitResult?.exitCode;
	const codeText = code === null || code === undefined ? "" : ` (exit code ${code})`;
	const tail = sanitizeTerminalOutput(runtime.fullOutput()).trimEnd();
	let tailSection = "";
	if (tail.length > 0) {
		const truncated = tail.length > NOTICE_TAIL_MAX_CHARS;
		const shown = truncated ? tail.slice(tail.length - NOTICE_TAIL_MAX_CHARS) : tail;
		const note = truncated
			? `\n[Final output truncated to the last ${NOTICE_TAIL_MAX_CHARS} chars; the full history is still peekable.]`
			: "";
		tailSection = `\nFinal output:\n${shown}${note}`;
	}
	const trustSection = trustText === undefined ? "" : `\n${trustText}`;
	return `<system-reminder>Background terminal session ${id} finished: ${status}${codeText}.${reapText}${tailSection}${trustSection}</system-reminder>`;
}

/**
 * Notifies an interactive agent once when a background session completes.
 *
 * Guards (todo 23): never wakes in one-shot `-p`/`--print`/`--mode json` runs; never wakes
 * without an active model (would spin an auth-less turn); `notify:"off"` suppresses entirely;
 * each session id fires at most once. `wake` steers immediately; `next-turn` queues a follow-up.
 */
export class TerminalNotifier {
	private readonly notified = new Set<string>();
	private readonly deps: TerminalNotifierDeps;
	private retired = false;

	constructor(deps: TerminalNotifierDeps) {
		this.deps = deps;
	}

	notifyCompletion(id: string, runtime: TerminalExitView): void {
		if (this.retired || this.notified.has(id)) return;
		withTerminalContext(
			() => this.deliverCompletion(id, runtime),
			() => this.retire(),
		);
	}

	/** A still-running session's age notice (senpi#6201), delivered like a completion notice. */
	notifyAge(event: TerminalBackgroundAgeEvent): void {
		if (this.retired || this.notified.has(event.id)) return;
		withTerminalContext(
			() =>
				getTerminalNotificationDelivery(this.deps)?.send(
					`<system-reminder>${describeBackgroundAge(event)}</system-reminder>`,
					{ details: { backgroundAge: event } },
				),
			() => this.retire(),
		);
	}

	private retire(): void {
		this.retired = true;
		this.notified.clear();
	}

	private deliverCompletion(id: string, runtime: TerminalExitView): void {
		const delivery = getTerminalNotificationDelivery(this.deps);
		if (!delivery) return;

		this.notified.add(id);
		const annotation = annotateShellTrust({
			exitCode: runtime.exitResult?.exitCode ?? null,
			output: runtime.fullOutput(),
		});
		delivery.send(
			buildNotice(id, runtime, annotation?.text),
			annotation === undefined ? undefined : { details: { trust: annotation.trust } },
		);
	}
}
