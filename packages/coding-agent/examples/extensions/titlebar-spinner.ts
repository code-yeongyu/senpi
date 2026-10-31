/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   senpi --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The host retires an extension ctx once its session is replaced (new/fork/switch) or
 * reloaded, and every later read of `ctx.ui` throws. A ticker that keeps its ctx across
 * ticks has to recognize that error and stop: the tick runs in an interval callback with
 * no catcher above it, so an escaping throw takes the process down (senpi#2549).
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

function getBaseTitle(pi: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = pi.getSessionName();
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopTimer() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
	}

	/** Returns false when the ctx was retired, so the ticker stops instead of rearming. */
	function setTitle(ctx: ExtensionContext, title: string): boolean {
		try {
			ctx.ui.setTitle(title);
			return true;
		} catch (error) {
			if (!isStaleExtensionContext(error)) throw error;
			return false;
		}
	}

	function stopAnimation(ctx: ExtensionContext) {
		stopTimer();
		setTitle(ctx, getBaseTitle(pi));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = pi.getSessionName();
			const title = session ? `${frame} π - ${session} - ${cwd}` : `${frame} π - ${cwd}`;
			if (!setTitle(ctx, title)) {
				stopTimer();
				return;
			}
			frameIndex++;
		}, 80);
	}

	pi.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
