import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import { createShowHtmlPageTool } from "../../../src/extensions/html-render/tool.ts";
import { contextHost } from "../rpc-session-context-support.ts";

// senpi#6346: show_html_page read the `app` prompt surface as "this host renders the page inline", but the prompt
// surface only says how replies are formatted. A client that opens with `app` and renders no pages got a result
// claiming the reader saw the page. Inline display is now the client's own `inline_html` capability.

const HTML_RENDER_EXTENSION = `export { default } from ${JSON.stringify(
	fileURLToPath(new URL("../../../src/extensions/html-render/index.ts", import.meta.url)),
)};`;

const INLINE = /shown to the reader inline/i;
const NOT_DISPLAYED = /not displayed/i;

const ctxFor = (cwd: string, fields: { promptSurface?: "app" }): ExtensionToolContext =>
	({
		cwd,
		hasUI: false,
		ui: undefined,
		tools: [],
		executeTool: () => Promise.reject(new Error("not used")),
		sessionManager: { getEntries: () => [], getSessionId: () => randomUUID() },
		...fields,
	}) as unknown as ExtensionToolContext;

describe("senpi#6346: show_html_page claims an inline display only for a client that renders pages", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-6346-"));
		vi.stubEnv("SENPI_PROMPT_SURFACE", undefined);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const show = async (fields: { promptSurface?: "app" }) => {
		const result = await createShowHtmlPageTool(new Map()).execute(
			"call-6346",
			{ html: "<p>chart</p>", title: "Chart" },
			undefined,
			undefined,
			ctxFor(tempDir, fields),
		);
		return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	};

	it("on the app surface without the inline capability says the page was not displayed", async () => {
		const text = await show({ promptSurface: "app" });
		expect(text).toMatch(NOT_DISPLAYED);
		expect(text).not.toMatch(INLINE);
	});

	it.each([
		["without", [], NOT_DISPLAYED],
		["with", ["inline_html"], INLINE],
	] as const)(
		"over RPC, an app-surface client %s inline_html gets the matching result",
		async (_label, capabilities, expected) => {
			const faux = fauxProvider({ api: "faux6346", provider: "faux6346" });
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("show_html_page", { html: "<p>chart</p>", title: "Chart" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await using host = await contextHost({ faux, extension: HTML_RENDER_EXTENSION });
			await host.send("conn-app", { type: "set_client_info", capabilities: [...capabilities] });
			const opened = await host.open("conn-app", { promptSurface: "app" });
			const sessionId = String(opened.sessionId);

			await host.prompt("conn-app", sessionId, "Show the chart.");

			const end = await host.waitFor(
				(record) => record.type === "tool_execution_end" && record.sessionId === sessionId,
			);
			expect(JSON.stringify(end.result)).toMatch(expected);
		},
		120_000,
	);
});
