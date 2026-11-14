/**
 * Syncs senpi theme with macOS system appearance (dark/light mode).
 *
 * Usage:
 *   senpi -e examples/extensions/mac-system-theme.ts
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";

const execAsync = promisify(exec);

/**
 * The host retires an extension ctx once its session is replaced (new/fork/switch) or
 * reloaded, and every later read of `ctx.ui` throws. This poll keeps its ctx across 2s
 * ticks, and its callback is async, so an escaping throw lands as an unhandled rejection
 * that also takes the process down (senpi#2549).
 */
const STALE_EXTENSION_CONTEXT_MESSAGES = [
	"This extension ctx is stale after session replacement or reload.",
	"stale extension generation after reload",
];

function isStaleExtensionContext(error: unknown): boolean {
	return (
		error instanceof Error && STALE_EXTENSION_CONTEXT_MESSAGES.some((message) => error.message.startsWith(message))
	);
}

async function isDarkMode(): Promise<boolean> {
	try {
		const { stdout } = await execAsync(
			"osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | null = null;

	function stopPolling() {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	}

	/** Returns false when the ctx was retired, so the poll stops instead of rearming. */
	function setTheme(ctx: ExtensionContext, theme: string): boolean {
		try {
			ctx.ui.setTheme(theme);
			return true;
		} catch (error) {
			if (!isStaleExtensionContext(error)) throw error;
			return false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		let currentTheme = (await isDarkMode()) ? "dark" : "light";
		if (!setTheme(ctx, currentTheme)) return;

		intervalId = setInterval(async () => {
			const newTheme = (await isDarkMode()) ? "dark" : "light";
			if (newTheme === currentTheme) return;
			currentTheme = newTheme;
			if (!setTheme(ctx, currentTheme)) stopPolling();
		}, 2000);
	});

	pi.on("session_shutdown", () => {
		stopPolling();
	});
}
