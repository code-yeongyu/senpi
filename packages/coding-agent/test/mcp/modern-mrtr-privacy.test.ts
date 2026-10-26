import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import {
	initialHerdrState,
	reduceHerdrState,
	selectHerdrReport,
} from "../../src/core/extensions/builtin/herdr/herdr-state.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { cleanupHerdrReporterFixtures, herdrReporterFixture } from "../suite/herdr-reporter-harness.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";

afterEach(async () => {
	await cleanupHerdrReporterFixtures();
	vi.unstubAllEnvs();
});

describe("ephemeral TUI wrappers", () => {
	it.each(["select", "input", "confirm"] as const)(
		"private %s emits no blocked events or pending markers",
		async (method) => {
			const events: Array<{ active: boolean; id: string; label?: string }> = [];
			let state = initialHerdrState();
			const reports: unknown[] = [];
			const mode = Object.create(InteractiveMode.prototype);
			Object.defineProperty(mode, "session", {
				value: {
					emitExtensionEvent: (_name: string, event: (typeof events)[number]) => {
						events.push(event);
						state = reduceHerdrState(state, { type: "blocked", ...event });
						reports.push(selectHerdrReport(state));
					},
				},
			});
			mode.showExtensionSelector = vi.fn().mockResolvedValue(undefined);
			mode.showExtensionInput = vi.fn().mockResolvedValue(undefined);
			mode.showExtensionConfirm = vi.fn().mockResolvedValue(false);
			const ui = mode.createExtensionUIContext() as ExtensionUIContext;
			const opts = { ephemeral: true, signal: new AbortController().signal };
			if (method === "select") await ui.select("TITLE_CANARY", ["answer"], opts);
			if (method === "input") await ui.input("TITLE_CANARY", "schema canary", opts);
			if (method === "confirm") await ui.confirm("TITLE_CANARY", "message canary", opts);
			expect(events).toEqual([]);
			expect(JSON.stringify(reports)).not.toContain("CANARY");
			expect(state.blocked.size).toBe(0);
		},
	);
	it("private titles never reach pane.report_agent through the real publisher", async () => {
		const f = await herdrReporterFixture();
		await f.start();
		const pending: Promise<unknown>[] = [];
		const ui = mrtrTui();
		Object.defineProperty(ui.host, "session", {
			configurable: true,
			value: {
				emitExtensionEvent: (_name: string, data: unknown) => {
					pending.push(f.bus("herdr:blocked", data));
				},
			},
		});
		await ui.ui.select("PRIVATE_TITLE_CANARY", ["answer"], { ephemeral: true });
		await Promise.all(pending);
		const reports = f.requests.filter((request) => request.method === "pane.report_agent");
		expect(reports.some((request) => request.params.state === "blocked")).toBe(false);
		expect(JSON.stringify(reports)).not.toContain("MCP input required");
		expect(JSON.stringify(reports)).not.toContain("CANARY");
	});
	it("already aborted consent shows no dialog and emits no blocked event", async () => {
		const select = vi.fn().mockResolvedValue(undefined);
		const f = mrtrTui(select);
		const controller = new AbortController();
		controller.abort();
		await f.ui.select("PRIVATE", ["choice"], { ephemeral: true, signal: controller.signal });
		expect(select).not.toHaveBeenCalled();
		expect(f.events).toEqual([]);
	});
	it("ordinary aborted dialogs still delegate and publish their normal blocked lifecycle", async () => {
		const select = vi.fn().mockResolvedValue("ordinary result");
		const f = mrtrTui(select);
		const signal = AbortSignal.abort();
		expect(await f.ui.select("ordinary", ["choice"], { signal })).toBe("ordinary result");
		expect(select).toHaveBeenCalledOnce();
		expect(f.events).toEqual([
			expect.objectContaining({ active: true, label: "ordinary" }),
			expect.objectContaining({ active: false }),
		]);
	});
	it("renderer failure emits no private events and ordinary dialogs keep their label", async () => {
		const f = mrtrTui(async () => {
			throw new Error("renderer");
		});
		await expect(f.ui.select("PRIVATE", [], { ephemeral: true })).rejects.toThrow("renderer");
		expect(f.events).toEqual([]);
		const ordinary = mrtrTui();
		await ordinary.ui.select("ordinary title", ["choice"]);
		expect(ordinary.events[0]).toMatchObject({ label: "ordinary title" });
	});
});
