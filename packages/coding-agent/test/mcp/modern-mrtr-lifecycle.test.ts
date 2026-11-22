import { ProgressSchema, ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { mcpRequestOptions } from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { ExtensionSelectorComponent } from "../../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { cleanupMrtrLifecycle, fixture } from "./fixtures/mrtr-lifecycle.ts";
import { formInput, inputResult } from "./fixtures/mrtr-2026-server.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";

afterEach(cleanupMrtrLifecycle);

vi.mock("@modelcontextprotocol/sdk/shared/protocol.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@modelcontextprotocol/sdk/shared/protocol.js")>()),
	DEFAULT_REQUEST_TIMEOUT_MSEC: 2345,
}));

describe("MRTR deadlines and settlement", () => {
	it("uses the SDK default for both attempt and operation budgets when timeout is omitted", async () => {
		const f = await fixture([undefined]);
		const pending = f.client.callTool({ name: "test" });
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_TIMEOUT" });
		await f.transport.received.promise;
		const options = f.underlying.mock.calls[0]?.[2];
		f.clock.advance(840000);
		await rejected;
		expect(options).toMatchObject({
			timeout: 2345,
			maxTotalTimeout: 321105,
		});
		expect(f.transport.cancellations).toHaveLength(1);
		expect(f.clock.timers.size).toBe(0);
	});
	it.each(["Decline", "Cancel"] as const)(
		"a stopped multi-input batch (%s) never dispatches partial answers",
		async (stop) => {
			const f = await fixture([
				inputResult("batch", {
					first: formInput("first"),
					second: formInput("second"),
					third: formInput("third"),
				}),
				{ content: [{ type: "text", text: "must not dispatch" }] },
			]);
			const titles: string[] = [];
			const ui = mrtrTui(
				async (title, choices) => {
					titles.push(title);
					if (title.includes("second") && choices.includes("Continue")) return stop;
					return choices.includes("Submit") ? "Submit" : choices[0];
				},
				async () => "UNSENT_VALUE",
			);
			await expect(
				f.client.callTool({ name: "test" }, undefined, mcpRequestOptions(f.origin(ui.presentation))),
			).rejects.toMatchObject({ code: "MCP_MRTR_CANCELLED" });
			expect(titles.some((title) => title.includes("third"))).toBe(false);
			expect(f.transport.calls).toHaveLength(1);
			expect(JSON.stringify(f.transport.calls)).not.toContain("UNSENT_VALUE");
		},
	);
	it("duplicate and prior-round widget answers cannot dismiss the next round or dispatch again", async () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const empty = {
			method: "elicitation/create",
			params: {
				message: "empty form",
				requestedSchema: { type: "object", properties: {} },
			},
		};
		const f = await fixture([
			inputResult("one", { question: empty }),
			inputResult("two", { question: empty }),
			{ content: [{ type: "text", text: "final" }] },
		]);
		const ui = mrtrTui();
		delete ui.host.showExtensionSelector;
		const shown = Array.from({ length: 4 }, () => Promise.withResolvers<ExtensionSelectorComponent>());
		let index = 0;
		const admit = vi.fn();
		Object.assign(ui.host.session, { emitExtensionEvent: vi.fn(), admitHumanAnswer: admit });
		ui.host.ui = { terminal: { rows: 30 }, setFocus: vi.fn(), requestRender: vi.fn(), renderNow: vi.fn() };
		ui.host.editor = {};
		ui.host.disposeActiveSelector = vi.fn();
		ui.host.editorContainer = {
			clear: vi.fn(),
			addChild: (component: unknown) => {
				if (component instanceof ExtensionSelectorComponent) shown[index++]?.resolve(component);
			},
		};
		const pending = f.client.callTool({ name: "test" }, undefined, mcpRequestOptions(f.origin(ui.presentation)));
		const nextWidget = async (at: number) => {
			const widget = shown[at];
			if (!widget) throw new Error("Missing widget barrier");
			return await Promise.race([
				widget.promise,
				pending.then(() => {
					throw new Error(`Request settled before widget ${at}`);
				}),
			]);
		};
		(await nextWidget(0)).handleInput("\n");
		const oldReview = await nextWidget(1);
		expect(admit).toHaveBeenCalledTimes(1);
		oldReview.handleInput("\n");
		(await nextWidget(2)).handleInput("\n");
		const currentReview = await nextWidget(3);
		expect(admit).toHaveBeenCalledTimes(3);
		oldReview.handleInput("\n");
		oldReview.handleInput("\u001b");
		expect(admit).toHaveBeenCalledTimes(3);
		const stillCurrent = ui.host.extensionSelector;
		currentReview.handleInput("\n");
		await pending;
		// senpi#4210: default ephemeral selects keep the ordinary scheduled render path.
		expect(ui.host.ui.renderNow).not.toHaveBeenCalled();
		expect(ui.host.ui.requestRender).toHaveBeenCalled();
		expect(stillCurrent).toBe(currentReview);
		expect(admit).toHaveBeenCalledTimes(4);
		expect(f.transport.calls).toHaveLength(3);
		expect(f.transport.calls[1]).toHaveProperty(["params", "requestState"], "one");
		expect(f.transport.calls[2]).toHaveProperty(["params", "requestState"], "two");
	});
	it("supplied maxTotalTimeout is a duration from a nonzero start", async () => {
		const f = await fixture([inputResult(), { content: [{ type: "text", text: "final" }] }]);
		const ui = mrtrTui(async (_title, choices) => {
			if (choices.includes("Submit")) {
				f.clock.advance(1250);
				return "Submit";
			}
			return choices[0];
		});
		await f.client.callTool(
			{ name: "test" },
			undefined,
			mcpRequestOptions(f.origin(ui.presentation), { timeout: 1000, maxTotalTimeout: 2000 }),
		);
		expect(f.underlying.mock.calls[0]?.[2]).toMatchObject({ timeout: 1000, maxTotalTimeout: 2000 });
		expect(f.underlying.mock.calls[1]?.[2]).toMatchObject({ timeout: 750, maxTotalTimeout: 750 });
		expect(f.clock.timers.size).toBe(0);
	});
	it("omitted maxTotalTimeout uses the bounded operation duration", async () => {
		const f = await fixture([undefined]);
		const pending = f.client.callTool({ name: "test" }, undefined, { timeout: 1000 });
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_TIMEOUT" });
		await f.transport.received.promise;
		expect(f.underlying.mock.calls[0]?.[2]).toMatchObject({ maxTotalTimeout: 309000, timeout: 1000 });
		f.clock.advance(309000);
		await rejected;
		expect(f.transport.calls).toHaveLength(1);
		expect(f.transport.cancellations).toHaveLength(1);
		expect(f.clock.timers.size).toBe(0);
	});
	it("progress near the deadline cannot extend the logical operation", async () => {
		const f = await fixture([undefined]);
		const updates: unknown[] = [];
		const progressed = Promise.withResolvers<void>();
		const pending = f.client.callTool({ name: "test" }, undefined, {
			timeout: 1000,
			maxTotalTimeout: 2000,
			resetTimeoutOnProgress: true,
			onprogress: (progress) => {
				updates.push(progress);
				progressed.resolve();
			},
		});
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_TIMEOUT" });
		await f.transport.received.promise;
		f.clock.advance(1999);
		f.transport.progress();
		await progressed.promise;
		f.clock.advance(1);
		await rejected;
		expect(updates).toEqual([{ progress: 1 }]);
		expect(JSON.stringify(updates)).not.toContain("CANARY");
		expect(f.transport.cancellations).toHaveLength(1);
	});
	it("operation deadline expires while queued for TUI consent", async () => {
		const f = await fixture([inputResult(), inputResult()]);
		const shown = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string | undefined>();
		const select = vi.fn(async (_title: string, _choices: string[], opts?: { signal?: AbortSignal }) => {
			shown.resolve();
			return await new Promise<string | undefined>((resolve) => {
				void release.promise.then(resolve);
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		});
		const ui = mrtrTui(select);
		const binding = {};
		const first = f.client.callTool(
			{ name: "test" },
			undefined,
			mcpRequestOptions(f.origin(ui.presentation, binding), { timeout: 1000, maxTotalTimeout: 10000 }),
		);
		const firstRejected = expect(first).rejects.toMatchObject({ code: "MCP_MRTR_CONTEXT_CHANGED" });
		await shown.promise;
		const secondSent = (f.transport.received = Promise.withResolvers<void>());
		const second = f.client.callTool(
			{ name: "test" },
			undefined,
			mcpRequestOptions(f.origin(ui.presentation, binding), { timeout: 1000, maxTotalTimeout: 100 }),
		);
		const secondRejected = expect(second).rejects.toMatchObject({ code: "MCP_MRTR_TIMEOUT" });
		await secondSent.promise;
		f.clock.advance(100);
		await secondRejected;
		f.lifetime.abort();
		await firstRejected;
		release.resolve(undefined);
		expect(select).toHaveBeenCalledTimes(1);
		expect(f.transport.calls).toHaveLength(2);
	});
	it("caller abort wins before continuation submission", async () => {
		const f = await fixture([inputResult()]);
		const caller = new AbortController();
		const ui = mrtrTui(async (_title, choices) => {
			if (choices.includes("Submit")) {
				caller.abort("PRIVATE_ABORT_CANARY");
				return "Submit";
			}
			return choices[0];
		});
		await expect(
			f.client.callTool(
				{ name: "test" },
				undefined,
				mcpRequestOptions(f.origin(ui.presentation), { signal: caller.signal }),
			),
		).rejects.toMatchObject({ code: "MCP_MRTR_CANCELLED" });
		expect(f.transport.calls).toHaveLength(1);
		expect(f.transport.cancellations).toHaveLength(0);
	});
	it("raw request uses the same MRTR adapter and final custom schema", async () => {
		const f = await fixture([{ resultType: "input_required", requestState: "" }, { final: 42 }]);
		const result = await f.client.request(
			{ method: "tools/call", params: { name: "test" } },
			ResultSchema.pick({}).extend({ final: ProgressSchema.shape.progress }).strip(),
		);
		expect(result).toEqual({ final: 42 });
		expect(f.transport.calls).toHaveLength(2);
		expect(f.transport.calls[1]).toMatchObject({ params: { requestState: "" } });
	});
});
