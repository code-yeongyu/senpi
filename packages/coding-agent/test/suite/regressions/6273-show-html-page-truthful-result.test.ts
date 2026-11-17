import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { showHtmlPageTool } from "../../../src/core/extensions/builtin/html-render/tool.ts";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";

// senpi#6273: show_html_page said "Open it in the desktop" even where the desktop had already shown the page
// inline, so the model reported a failure and, trusting that result in later turns, refused to call the tool.
// The result now states what happened on this host: shown inline (OmO desktop, prompt surface `app`) or only
// written to a file.

type Surface = "terminal" | "app" | "chat";

const ctxFor = (cwd: string, surface: Surface | undefined): ExtensionToolContext =>
	({
		cwd,
		hasUI: false,
		ui: undefined,
		tools: [],
		executeTool: () => Promise.reject(new Error("not used")),
		...(surface === undefined ? {} : { getSystemPromptOptions: () => ({ surface }) }),
	}) as unknown as ExtensionToolContext;

async function show(cwd: string, surface: Surface | undefined): Promise<{ text: string; path: string }> {
	const result = await showHtmlPageTool.execute(
		"call-6273",
		{ html: "<p>chart</p>", title: "Chart" },
		undefined,
		undefined,
		ctxFor(cwd, surface),
	);
	const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	return { text, path: result.details.path };
}

describe("senpi#6273: show_html_page reports what the host did with the page", () => {
	let tempDir: string;
	let savedSurface: string | undefined;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-6273-"));
		savedSurface = process.env.SENPI_PROMPT_SURFACE;
		delete process.env.SENPI_PROMPT_SURFACE;
	});
	afterEach(() => {
		if (savedSurface === undefined) delete process.env.SENPI_PROMPT_SURFACE;
		else process.env.SENPI_PROMPT_SURFACE = savedSurface;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("in the desktop thread says the page was shown inline, names the saved file, and asks nothing of the model", async () => {
		const { text, path } = await show(tempDir, "app");
		expect(text).toMatch(/shown to the reader inline/i);
		expect(text).toContain(path);
		expect(text).not.toMatch(/open it in the desktop/i);
		expect(text).not.toMatch(/not displayed/i);
	});

	it("reads the surface from SENPI_PROMPT_SURFACE when the session names none", async () => {
		process.env.SENPI_PROMPT_SURFACE = "app";
		const { text } = await show(tempDir, undefined);
		expect(text).toMatch(/shown to the reader inline/i);
	});

	it.each(["terminal", "chat", undefined] as const)(
		"on a host that does not render pages (surface %s) says the page was written and not displayed",
		async (surface) => {
			const { text, path } = await show(tempDir, surface);
			expect(text).toContain(`Wrote the page to ${path}.`);
			expect(text).toMatch(/not displayed/i);
			expect(text).not.toMatch(/open it in the desktop/i);
			expect(text).not.toMatch(/inline above/i);
		},
	);
});
