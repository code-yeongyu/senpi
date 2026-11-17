import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_HANDED_PAGE_CHARACTERS, showHtmlPageTool } from "../../src/core/extensions/builtin/html-render/tool.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { MAX_RPC_LINE_CHARACTERS } from "../../src/modes/rpc/jsonl.ts";

// senpi#6899: the page handed to the host in `details` rides every RPC record that carries the
// result, and a record over MAX_RPC_LINE_CHARACTERS drops an attach connection. The inlined page is
// handed only while it fits MAX_HANDED_PAGE_CHARACTERS; a larger one is handed as written.

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_PREFIX = "data:image/png;base64,";

const ctxFor = (cwd: string): ExtensionToolContext =>
	({
		cwd,
		hasUI: false,
		ui: undefined,
		tools: [],
		executeTool: () => Promise.reject(new Error("not used")),
	}) as unknown as ExtensionToolContext;

/** A page with one image whose inlined length is `MAX_HANDED_PAGE_CHARACTERS + overBy` give or take under 4 characters. */
function pageInlinedNear(dir: string, overBy: number): { html: string; inlinedLength: number } {
	const path = join(dir, "shot.png");
	const html = `<img src="${path}">`;
	const fixed = html.length - path.length + DATA_PREFIX.length;
	const groups = Math.floor((MAX_HANDED_PAGE_CHARACTERS + overBy - fixed) / 4);
	writeFileSync(path, Buffer.concat([PNG_HEAD, Buffer.alloc(groups * 3 - PNG_HEAD.length, 7)]));
	return { html, inlinedLength: fixed + groups * 4 };
}

async function show(cwd: string, html: string) {
	const result = await showHtmlPageTool.execute(
		"call-6899",
		{ html, title: "Shot" },
		undefined,
		undefined,
		ctxFor(cwd),
	);
	const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	return { result, text };
}

describe("senpi#6899: the page handed to the host stays under the RPC line limit", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-6899-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("hands the inlined page when it is just under the cap, and the result record fits one RPC line", async () => {
		const { html, inlinedLength } = pageInlinedNear(tempDir, 0);
		expect(inlinedLength).toBeLessThanOrEqual(MAX_HANDED_PAGE_CHARACTERS);
		expect(inlinedLength).toBeGreaterThan(MAX_HANDED_PAGE_CHARACTERS - 4);

		const { result, text } = await show(tempDir, html);

		expect(result.details.imagesInlined).toBe(true);
		expect(result.details.html.length).toBe(inlinedLength);
		expect(result.details.html.startsWith(`<img src="${DATA_PREFIX}`)).toBe(true);
		expect(text).toContain("Local images were inlined.");
		const record = JSON.stringify({ type: "tool_execution_end", toolCallId: "call-6899", result });
		expect(record.length).toBeLessThan(MAX_RPC_LINE_CHARACTERS);
	});

	it("hands the page as written when inlining takes it over the cap, keeps the inlined saved copy, and says so", async () => {
		const { html, inlinedLength } = pageInlinedNear(tempDir, 4);
		expect(inlinedLength).toBeGreaterThan(MAX_HANDED_PAGE_CHARACTERS);

		const { result, text } = await show(tempDir, html);

		expect(result.details.imagesInlined).toBe(false);
		expect(result.details.html).toBe(html);
		expect(readFileSync(result.details.path, "utf8")).toContain(DATA_PREFIX);
		expect(text).toContain(
			`with them the page is ${inlinedLength} characters, over the ${MAX_HANDED_PAGE_CHARACTERS} a page can carry to a viewer, so a viewer on another machine will not see the images.`,
		);
	});

	it("writes a page that only names a missing image path in text or code, and leaves the path as written", async () => {
		const named = join(tempDir, "out.png");
		const html = `<p>The chart is saved to <code>"${named}"</code>.</p>`;

		const { result } = await show(tempDir, html);

		expect(result.details.html).toBe(html);
		expect(result.details.imagesInlined).toBe(true);
	});
});
