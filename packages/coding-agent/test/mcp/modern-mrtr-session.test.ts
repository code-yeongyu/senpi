import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import type { ExtensionAPI, UIPromptEndEvent, UIPromptStartEvent } from "../../src/core/extensions/types.ts";
import { markMcpFormPresented } from "../../src/core/mcp-form-types.ts";
import { getMcpMrtrPresentation } from "../../src/core/mcp-mrtr-presentations.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText } from "../suite/harness.ts";
import { formInput, inputResult, MrtrScript, startMrtrServer } from "./fixtures/mrtr-2026-server.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";

const cleanup: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function realSession(host = true, enforcement = true) {
	const script = new MrtrScript([inputResult("state", { question: formInput("SERVER_TEXT_CANARY") })]);
	const server = await startMrtrServer(script);
	cleanup.push(server.close);
	const service = new McpService();
	cleanup.push(() => service.dispose("quit"));
	const events: Array<UIPromptStartEvent | UIPromptEndEvent> = [];
	const controlEnded = Promise.withResolvers<void>();
	const waits: unknown[] = [];
	const input = vi.fn(async () => "VALUE_CANARY");
	const select = vi.fn(async (_title: string, choices: string[], opts?: { ephemeral?: boolean }) => {
		if (opts?.ephemeral) {
			waits.push(harness.getExtensionRunner().getLifecycleHumanWait());
			// The mocked selector stands in for the terminal renderer, which acknowledges an actual frame.
			markMcpFormPresented(opts);
		}
		return choices.includes("Submit") ? "Submit" : choices[0];
	});
	const raw = mrtrTui(select, input, enforcement);
	let owner: ExtensionAPI | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerMcpServer("fixture", { type: "http", url: server.url, auth: false, exposure: "direct" });
				pi.on("ui_prompt_start", (event) => {
					events.push(event);
				});
				pi.on("ui_prompt_end", (event) => {
					events.push(event);
					if (event.title === "ordinary control") controlEnded.resolve();
				});
			},
			(pi) => {
				owner = pi;
				return createMcpExtension(service)(pi);
			},
		],
	});
	cleanup.push(async () => {
		harness.cleanup();
	});
	await harness.session.bindExtensions({ uiContext: host ? raw.ui : createTestUiContext(), mode: "tui" });
	expect(await service.whenAttachSettled(10000)).toBe("settled");
	if (!owner) throw new Error("MCP extension owner missing");
	return {
		script,
		service,
		harness,
		raw,
		owner,
		input,
		select,
		events,
		waits,
		controlEnded,
		call: () => harness.session.executeTool("mcp_fixture_fixture", {}),
	};
}

describe("MRTR real session presenter binding", () => {
	it("queues concurrent terminal forms with enforcement off", async () => {
		const f = await realSession(true, false);
		f.script.results.push(inputResult("second"));
		const shown = Promise.withResolvers<void>();
		const submit = Promise.withResolvers<string>();
		let forms = 0;
		f.select.mockImplementation(async (_title, choices, options) => {
			markMcpFormPresented(options);
			if (choices.includes("Submit") && ++forms === 1) {
				shown.resolve();
				return submit.promise;
			}
			return choices.includes("Submit") ? "Submit" : choices[0];
		});
		const first = f.call();
		await shown.promise;
		const received = f.script.next("inputResultSent");
		const second = f.call();
		await received;
		expect(forms).toBe(1);
		submit.resolve("Submit");
		const results = await Promise.all([first, second]);
		expect(results.map(getMessageText)).toEqual(["final tool", "final tool"]);
		expect(forms).toBe(2);
		expect(f.script.requests).toHaveLength(4);
		expect(f.raw.presentation.privateForms).toBeUndefined();
	});
	it("declares form capability and presents a form through AgentSession and ExtensionRunner", async () => {
		const f = await realSession();
		expect(f.harness.getExtensionRunner().getUIContext()).not.toBe(f.raw.ui);
		const result = await f.call();
		expect(f.script.requests[0]?.params).toHaveProperty(["_meta", "io.modelcontextprotocol/clientCapabilities"], {
			elicitation: {},
		});
		expect(f.input).toHaveBeenCalledOnce();
		expect(getMessageText(result)).toContain("final tool");
		expect(f.script.requests[1]?.params).toHaveProperty(
			["inputResponses", "question", "content", "value"],
			"VALUE_CANARY",
		);
	});
	it("bypasses titled ui_prompt events and human-wait state while keeping ordinary wrappers active", async () => {
		const f = await realSession();
		await f.call();
		expect(f.input).toHaveBeenCalledOnce();
		await f.harness.getExtensionRunner().getUIContext().select("ordinary control", ["ok"]);
		await f.controlEnded.promise;
		expect(f.events.map((event) => ({ type: event.type, title: event.title }))).toEqual([
			{ type: "ui_prompt_start", title: "ordinary control" },
			{ type: "ui_prompt_end", title: "ordinary control" },
		]);
		expect(JSON.stringify(f.events)).not.toContain("CANARY");
		expect(f.waits.length).toBeGreaterThan(0);
		expect(f.waits.every((wait) => wait === undefined)).toBe(true);
		const presentation = getMcpMrtrPresentation(f.harness.getExtensionRunner().getUIContext());
		expect(presentation).toBe(f.raw.presentation);
		expect(presentation?.ui).toBe(f.raw.ui);
		expect(presentation?.privateForms).toBeDefined();
		expect(presentation?.privateForms).toBe(f.raw.presentation.privateForms);
	});
	it("retains a live presenter when a later lookup misses", async () => {
		const f = await realSession();
		f.service.bindMcpMrtrPresentation(f.owner, f.raw.ui);
		f.service.bindMcpMrtrPresentation(f.owner, createTestUiContext());
		expect(getMessageText(await f.call())).toContain("final tool");
		expect(f.input).toHaveBeenCalledOnce();
	});
	it("does not revive a presenter whose host lifetime ended", async () => {
		const f = await realSession();
		f.raw.lose();
		f.service.bindMcpMrtrPresentation(f.owner, createTestUiContext());
		await f.call();
		expect(f.script.requests[0]?.params).toHaveProperty(["_meta", "io.modelcontextprotocol/clientCapabilities"], {});
		expect(f.input).not.toHaveBeenCalled();
		expect(f.script.requests).toHaveLength(1);
	});
	it("does not grant a presenter to an unregistered UI merely because the session is TUI", async () => {
		const f = await realSession(false);
		await f.call();
		expect(f.script.requests[0]?.params).toHaveProperty(["_meta", "io.modelcontextprotocol/clientCapabilities"], {});
		expect(getMcpMrtrPresentation(f.harness.getExtensionRunner().getUIContext())).toBeUndefined();
		expect(f.input).not.toHaveBeenCalled();
		expect(f.script.requests).toHaveLength(1);
	});
});
