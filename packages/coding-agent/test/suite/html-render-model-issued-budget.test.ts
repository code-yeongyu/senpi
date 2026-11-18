import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CursorExecHandlers,
	fauxAssistantMessage,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionCursorExecBridge } from "../../src/core/cursor-exec-bridge-session.ts";
import htmlRenderExtension from "../../src/extensions/html-render/index.ts";
import { MAX_HANDED_PAGE_CHARACTERS, MAX_HANDED_PAGES_CHARACTERS } from "../../src/extensions/html-render/tool.ts";
import { createHarness, type Harness } from "./harness.ts";

// senpi#6915: a show_html_page call the model issued joins the transcript, so the session marks it `issuedByModel`
// and the page counts against the session's MAX_HANDED_PAGES_CHARACTERS budget. These run the real AgentSession,
// so a session that stops marking model calls (the agent loop or the Cursor exec channel) fails here.

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PAGE_SIZE = MAX_HANDED_PAGE_CHARACTERS - 100_000;
const PAGES = Math.floor(MAX_HANDED_PAGES_CHARACTERS / PAGE_SIZE) + 1;

/** A page whose one image inlines to about PAGE_SIZE characters. */
function bigPage(dir: string, name: string): { html: string; title: string } {
	const path = join(dir, `${name}.png`);
	writeFileSync(path, Buffer.concat([PNG_HEAD, Buffer.alloc(Math.floor(PAGE_SIZE / 4) * 3 - PNG_HEAD.length, 7)]));
	return { html: `<img src="${path}">`, title: name };
}

/** `details.imagesInlined` of a show_html_page result. */
const imagesInlined = (result: unknown): boolean =>
	typeof result === "object" &&
	result !== null &&
	"details" in result &&
	typeof result.details === "object" &&
	result.details !== null &&
	"imagesInlined" in result.details &&
	result.details.imagesInlined === true;

const expected = Array.from({ length: PAGES }, (_, index) => index < PAGES - 1);

describe("senpi#6915: a model-issued show_html_page reserves the session's page budget", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("counts each page the agent loop runs for the model", async () => {
		harness = await createHarness({ extensionFactories: [htmlRenderExtension] });
		const dir = harness.tempDir;
		harness.setResponses([
			...Array.from({ length: PAGES }, (_, index) =>
				fauxAssistantMessage(fauxToolCall("show_html_page", bigPage(dir, `loop-${index}`)), {
					stopReason: "toolUse",
				}),
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Show the pages.");

		const inlined = harness.session.messages
			.filter((message): message is ToolResultMessage => message.role === "toolResult")
			.map(imagesInlined);
		expect(inlined).toEqual(expected);
	});

	it("counts each page a Cursor exec frame runs while the issuing message is still streaming", async () => {
		const live = await createHarness({ extensionFactories: [htmlRenderExtension] });
		harness = live;
		const dir = live.tempDir;
		live.session.agent.cursorExecHandlers = (runSignal: AbortSignal) =>
			createSessionCursorExecBridge({ current: live.session }, () => live.session.agent, runSignal);
		const inlined: boolean[] = [];
		live.setResponses([
			async (_context, options) => {
				const handlers = (options as { execHandlers?: CursorExecHandlers } | undefined)?.execHandlers;
				for (let index = 0; index < PAGES; index++) {
					const result = await handlers?.mcp?.({
						name: "show_html_page",
						providerIdentifier: "senpi",
						toolName: "show_html_page",
						toolCallId: `cursor-frame-${index}`,
						args: bigPage(dir, `cursor-${index}`),
						rawArgs: {},
					});
					inlined.push(imagesInlined(result));
				}
				return fauxAssistantMessage("done");
			},
		]);

		await live.session.prompt("Show the pages.");

		expect(inlined).toEqual(expected);
	});

	// senpi#6919: a block after the session preflight passed (the owning run ended) skips afterToolCall; the call must
	// still stop counting as model-issued.
	it("forgets a Cursor exec-frame call the bridge blocks after its preflight passed", async () => {
		const runSignal = new AbortController().signal;
		let ownerSignal: AbortSignal = runSignal;
		let markedDuringPreflight: boolean | undefined;
		const live = await createHarness({
			extensionFactories: [
				htmlRenderExtension,
				(pi) =>
					pi.on("tool_call", (event) => {
						if (event.toolCallId !== "late-block") return undefined;
						markedDuringPreflight = live.session.extensionRunner.createToolContext(
							event.toolCallId,
							undefined,
						).issuedByModel;
						ownerSignal = new AbortController().signal;
						return undefined;
					}),
			],
		});
		harness = live;
		const agent = live.session.agent;
		const bridge = createSessionCursorExecBridge(
			{ current: live.session },
			() => ({
				signal: ownerSignal,
				emitExternalEvent: async () => undefined,
				batchStoreFactory: agent.batchStoreFactory,
				executionScope: agent.executionScope,
				getExecutionScope: () => agent.getExecutionScope?.() ?? agent.executionScope,
				onExecutionPipeline: undefined,
			}),
			runSignal,
		);

		const result = await bridge.mcp?.({
			name: "show_html_page",
			providerIdentifier: "senpi",
			toolName: "show_html_page",
			toolCallId: "late-block",
			args: { html: "<p>late</p>", title: "late" },
			rawArgs: {},
		});

		expect(JSON.stringify(result)).toContain("Tool execution has no active run");
		expect(markedDuringPreflight).toBe(true);
		expect(live.session.extensionRunner.createToolContext("late-block", undefined).issuedByModel).toBe(false);
	});
});
