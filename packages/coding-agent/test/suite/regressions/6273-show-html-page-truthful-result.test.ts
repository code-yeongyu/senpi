import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShowHtmlPageTool } from "../../../src/extensions/html-render/tool.ts";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";

// senpi#6273: show_html_page said "Open it in the desktop" even where the desktop had already shown the page
// inline, so the model reported a failure and, trusting that result in later turns, refused to call the tool.
// The result now states what happened: shown inline (a client that declared `inline_html`, the OmO desktop) or only
// written to a file. senpi#6346 moved that decision from the prompt surface to the client capability; the RPC path
// is covered in 6346-show-html-page-inline-capability.test.ts.

type Surface = "terminal" | "app" | "chat";

const ctxFor = (cwd: string, surface: Surface | undefined, inlineHtml?: boolean): ExtensionToolContext =>
	({
		cwd,
		hasUI: false,
		ui: undefined,
		tools: [],
		executeTool: () => Promise.reject(new Error("not used")),
		sessionManager: { getEntries: () => [], getSessionId: () => randomUUID() },
		...(surface === undefined ? {} : { promptSurface: surface }),
		...(inlineHtml === undefined ? {} : { inlineHtml }),
	}) as unknown as ExtensionToolContext;

async function show(
	cwd: string,
	surface: Surface | undefined,
	inlineHtml?: boolean,
): Promise<{ text: string; path: string }> {
	const result = await createShowHtmlPageTool(new Map()).execute(
		"call-6273",
		{ html: "<p>chart</p>", title: "Chart" },
		undefined,
		undefined,
		ctxFor(cwd, surface, inlineHtml),
	);
	const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	return { text, path: result.details.path };
}

describe("senpi#6273: show_html_page reports what the host did with the page", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-6273-"));
		vi.stubEnv("SENPI_PROMPT_SURFACE", undefined);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("in the desktop thread says the page was shown inline, names the saved file, and asks nothing of the model", async () => {
		const { text, path } = await show(tempDir, "app", true);
		expect(text).toMatch(/shown to the reader inline/i);
		expect(text).toContain(path);
		expect(text).not.toMatch(/open it in the desktop/i);
		expect(text).not.toMatch(/not displayed/i);
	});

	it("does not read SENPI_PROMPT_SURFACE=app as an inline display", async () => {
		vi.stubEnv("SENPI_PROMPT_SURFACE", "app");
		const { text } = await show(tempDir, undefined);
		expect(text).toMatch(/not displayed/i);
	});

	it.each(["terminal", "chat", undefined] as const)(
		"on a host whose client does not render pages (surface %s) says the page was written and not displayed",
		async (surface) => {
			const { text, path } = await show(tempDir, surface);
			expect(text).toContain(`Wrote the page to ${path}.`);
			expect(text).toMatch(/not displayed/i);
			expect(text).not.toMatch(/open it in the desktop/i);
			expect(text).not.toMatch(/inline above/i);
		},
	);
});
