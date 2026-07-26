import type { ExtensionContext } from "../../types.ts";
import { sanitizeTerminalOutput } from "./output-format.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import type { NotifyMode } from "./settings.ts";
import { describeExit } from "./tools/spawn.ts";

/** Modes that never wake the agent: one-shot, non-interactive runs. */
export const NON_INTERACTIVE_MODES = new Set(["print", "json"]);

export interface TerminalNotifierDeps {
	/** Deliver a user-visible completion message with the requested scheduling mode. */
	readonly sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
	readonly getContext: () => ExtensionContext | undefined;
	readonly getMode: () => NotifyMode;
}

/** Max chars of sanitized final output embedded in a completion notification. */
export const NOTICE_TAIL_MAX_CHARS = 2000;

export interface TerminalNotificationDelivery {
	readonly send: (content: string) => void;
}

/** Shared terminal-notification guard and notify-mode mapping. */
export function getTerminalNotificationDelivery(deps: TerminalNotifierDeps): TerminalNotificationDelivery | undefined {
	const mode = deps.getMode();
	if (mode === "off") return undefined;
	const ctx = deps.getContext();
	if (!ctx || NON_INTERACTIVE_MODES.has(ctx.mode) || !ctx.model) return undefined;
	return {
		send: (content) => deps.sendUserMessage(content, { deliverAs: mode === "wake" ? "steer" : "followUp" }),
	};
}

function buildNotice(id: string, runtime: TerminalRuntimeSession): string {
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
	return `<system-reminder>Background terminal session ${id} finished: ${status}${codeText}.${tailSection}</system-reminder>`;
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

	constructor(deps: TerminalNotifierDeps) {
		this.deps = deps;
	}

	notifyCompletion(id: string, runtime: TerminalRuntimeSession): void {
		if (this.notified.has(id)) return;
		const delivery = getTerminalNotificationDelivery(this.deps);
		if (!delivery) return;

		this.notified.add(id);
		delivery.send(buildNotice(id, runtime));
	}
}
