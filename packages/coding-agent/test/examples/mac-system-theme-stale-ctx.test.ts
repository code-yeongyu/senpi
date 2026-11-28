import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";

const appearanceProbe = vi.hoisted(() => ({ stdout: "false", calls: 0 }));

vi.mock("node:child_process", () => ({
	exec: (_command: string, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
		appearanceProbe.calls += 1;
		callback(null, { stdout: `${appearanceProbe.stdout}\n`, stderr: "" });
	},
}));

import macSystemTheme from "../../examples/extensions/mac-system-theme.ts";
import { REPLACEMENT_STALE_MESSAGE, retirableContext } from "../suite/regressions/2549-retirable-context-support.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

const POLL_INTERVAL_MS = 2000;

function loadThemeSync() {
	const handlers = new Map<string, EventHandler>();
	const themes: string[] = [];
	const api = { on: (event: string, handler: EventHandler) => handlers.set(event, handler) };
	macSystemTheme(api as unknown as ExtensionAPI);
	const context = retirableContext({
		cwd: "/tmp/mac-theme",
		sessionId: "mac-theme",
		ui: { setTheme: (theme: string) => themes.push(theme) },
	});
	return { handlers, themes, context };
}

async function dispatch(handlers: Map<string, EventHandler>, event: string, ctx: ExtensionContext) {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`the example registered no ${event} handler`);
	await handler({ type: event }, ctx);
}

describe("mac-system-theme against a retired extension ctx", () => {
	afterEach(() => {
		vi.useRealTimers();
		appearanceProbe.stdout = "false";
		appearanceProbe.calls = 0;
	});

	it("stops polling instead of rejecting when a session replacement retires the ctx", async () => {
		vi.useFakeTimers();
		appearanceProbe.stdout = "true";
		const { handlers, themes, context } = loadThemeSync();
		await dispatch(handlers, "session_start", context.context);
		expect(themes).toEqual(["dark"]);

		// The poll's async callback has no catcher above it, so the retired ctx used to
		// reject as an unhandled rejection and take the whole process down (senpi#2549).
		context.retire(REPLACEMENT_STALE_MESSAGE);
		appearanceProbe.stdout = "false";
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(themes).toEqual(["dark"]);

		const probesAfterRetire = appearanceProbe.calls;
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
		expect(appearanceProbe.calls).toBe(probesAfterRetire);
	});

	it("applies a system appearance change while the session is live", async () => {
		vi.useFakeTimers();
		const { handlers, themes, context } = loadThemeSync();
		await dispatch(handlers, "session_start", context.context);
		expect(themes).toEqual(["light"]);

		appearanceProbe.stdout = "true";
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(themes).toEqual(["light", "dark"]);

		await dispatch(handlers, "session_shutdown", context.successor);
		const probesAfterShutdown = appearanceProbe.calls;
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
		expect(appearanceProbe.calls).toBe(probesAfterShutdown);
	});
});
