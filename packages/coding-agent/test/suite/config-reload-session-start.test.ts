import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigReloadHarness } from "./config-reload-harness.ts";

describe("reload requested while session_start is dispatching", () => {
	// senpi#2719: a nested reload retired the runner whose remaining session_start handlers were still running.
	it("is deferred, so later session_start handlers keep a live context", async () => {
		// Given: an early handler that requests a reload from inside the reload's session_start dispatch,
		// and a later handler that reads its context.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-session-start-"));
		let nested: { cancelled: boolean; reason?: string } | undefined;
		let lateContextError: string | undefined;
		let lateHandlerRuns = 0;
		let requestReload: () => Promise<{ cancelled: boolean; reason?: string }> = async () => ({ cancelled: false });
		const { harness } = await createConfigReloadHarness(root.path, (pi) => {
			let requested = false;
			pi.on("session_start", async (event) => {
				if (event.reason !== "reload" || requested) return;
				requested = true;
				nested = await requestReload();
			});
			pi.on("session_start", async (event, ctx) => {
				if (event.reason !== "reload") return;
				lateHandlerRuns += 1;
				try {
					void ctx.cwd;
				} catch (error) {
					lateContextError = error instanceof Error ? error.message : String(error);
				}
			});
		});
		requestReload = () => harness.session.reload();

		// When: the host reloads.
		const outer = await harness.session.reload();

		// Then: the nested request is refused with a reason, the outer reload completes once,
		// and the later handler ran on a live context.
		expect(lateContextError).toBeUndefined();
		expect(outer).toEqual({ cancelled: false });
		expect(nested).toEqual({ cancelled: true, reason: "A session is starting." });
		expect(lateHandlerRuns).toBe(1);

		// And: the veto lifts once dispatch ends.
		expect(await harness.session.checkReloadVeto()).toEqual({ cancelled: false });
		harness.cleanup();
	});
});
