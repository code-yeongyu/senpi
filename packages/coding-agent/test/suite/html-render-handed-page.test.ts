import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import htmlRenderExtension from "../../src/core/extensions/builtin/html-render/index.ts";
import {
	MAX_HANDED_PAGE_CHARACTERS,
	MAX_HANDED_PAGES_CHARACTERS,
	createShowHtmlPageTool,
} from "../../src/core/extensions/builtin/html-render/tool.ts";
import type { ExtensionAPI, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { MAX_RPC_LINE_CHARACTERS } from "../../src/modes/rpc/jsonl.ts";

// senpi#6899, senpi#6907: the page handed to the host in `details` rides every RPC record that carries
// the result, and all of a session's pages ride together in get_messages, get_tree and agent_end. A record
// over MAX_RPC_LINE_CHARACTERS drops an attach connection, so pages are inlined only within a per-page cap
// and a per-session budget; past either, a page is handed as written.

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_PREFIX = "data:image/png;base64,";

type ShowHtmlPageTool = ReturnType<typeof createShowHtmlPageTool>;
type Result = Awaited<ReturnType<ShowHtmlPageTool["execute"]>>;

/** A session that records each returned result the way the agent session appends it. */
function session(cwd: string, tool: ShowHtmlPageTool = createShowHtmlPageTool(), sessionId = randomUUID()) {
	const entries: unknown[] = [];
	const ctx = {
		cwd,
		hasUI: false,
		ui: undefined,
		tools: [],
		executeTool: () => Promise.reject(new Error("not used")),
		sessionManager: { getEntries: () => entries, getSessionId: () => sessionId },
	} as unknown as ExtensionToolContext;
	const record = (toolCallId: string, result: Result) =>
		entries.push({
			type: "message",
			id: toolCallId,
			message: { role: "toolResult", toolCallId, toolName: "show_html_page", ...result, isError: false },
		});
	const show = async (toolCallId: string, html: string) => {
		const result = await tool.execute(toolCallId, { html, title: "Shot" }, undefined, undefined, ctx);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return { result, text };
	};
	return { ctx, entries, record, show };
}

/** Loads the extension the way a session runtime does: one instance, its tool and its lifecycle handlers. */
function loadExtension() {
	let tool: ShowHtmlPageTool | undefined;
	const handlers = new Map<string, () => void>();
	htmlRenderExtension({
		registerTool: (registered: ShowHtmlPageTool) => {
			tool = registered;
		},
		on: (event: string, handler: () => void) => handlers.set(event, handler),
	} as unknown as ExtensionAPI);
	if (tool === undefined) throw new Error("show_html_page was not registered");
	return { tool, emit: (event: string) => handlers.get(event)?.() };
}

/** A page with one image whose inlined length is `target`, give or take under 4 characters. */
function pageInlinedTo(dir: string, name: string, target: number): { html: string; inlinedLength: number } {
	const path = join(dir, `${name}.png`);
	const html = `<img src="${path}">`;
	const fixed = html.length - path.length + DATA_PREFIX.length;
	const groups = Math.floor((target - fixed) / 4);
	writeFileSync(path, Buffer.concat([PNG_HEAD, Buffer.alloc(groups * 3 - PNG_HEAD.length, 7)]));
	return { html, inlinedLength: fixed + groups * 4 };
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
		const { html, inlinedLength } = pageInlinedTo(tempDir, "shot", MAX_HANDED_PAGE_CHARACTERS);
		expect(inlinedLength).toBeLessThanOrEqual(MAX_HANDED_PAGE_CHARACTERS);
		expect(inlinedLength).toBeGreaterThan(MAX_HANDED_PAGE_CHARACTERS - 4);

		const { result, text } = await session(tempDir).show("call-6899", html);

		expect(result.details.imagesInlined).toBe(true);
		expect(result.details.html.length).toBe(inlinedLength);
		expect(result.details.html.startsWith(`<img src="${DATA_PREFIX}`)).toBe(true);
		expect(text).toContain("Local images were inlined.");
		const record = JSON.stringify({ type: "tool_execution_end", toolCallId: "call-6899", result });
		expect(record.length).toBeLessThan(MAX_RPC_LINE_CHARACTERS);
	});

	it("hands the page as written when inlining takes it over the cap, keeps the inlined saved copy, and says so", async () => {
		const { html, inlinedLength } = pageInlinedTo(tempDir, "shot", MAX_HANDED_PAGE_CHARACTERS + 4);
		expect(inlinedLength).toBeGreaterThan(MAX_HANDED_PAGE_CHARACTERS);

		const { result, text } = await session(tempDir).show("call-6899", html);

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

		const { result } = await session(tempDir).show("call-named", html);

		expect(result.details.html).toBe(html);
		expect(result.details.imagesInlined).toBe(true);
	});
});

describe("senpi#6907: a session's handed pages together stay under the RPC line limit", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-6907-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("inlines pages near the per-page cap until the session budget is spent, and get_messages of eight such pages fits one line", async () => {
		const { record, show, entries } = session(tempDir);
		const pageSize = MAX_HANDED_PAGE_CHARACTERS - 100_000;
		const inlinedPerBudget = Math.floor(MAX_HANDED_PAGES_CHARACTERS / pageSize);
		const outcomes: { inlined: boolean; text: string; inlinedLength: number }[] = [];
		for (let index = 0; index < 8; index++) {
			const { html, inlinedLength } = pageInlinedTo(tempDir, `page-${index}`, pageSize);
			const { result, text } = await show(`call-${index}`, html);
			record(`call-${index}`, result);
			outcomes.push({ inlined: result.details.imagesInlined, text, inlinedLength });
		}
		const handedBeforeRefusal = outcomes
			.slice(0, inlinedPerBudget)
			.reduce((total, outcome) => total + outcome.inlinedLength, 0);

		expect(outcomes.map((outcome) => outcome.inlined)).toEqual(
			Array.from({ length: 8 }, (_, index) => index < inlinedPerBudget),
		);
		expect(outcomes[inlinedPerBudget]?.text).toContain(
			`this session's pages already carry ${handedBeforeRefusal} of the ${MAX_HANDED_PAGES_CHARACTERS} characters`,
		);
		const getMessages = JSON.stringify({
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: entries.map((entry) => (entry as { message: unknown }).message) },
		});
		expect(getMessages.length).toBeLessThan(MAX_RPC_LINE_CHARACTERS);
	});

	it("counts a concurrent call's page before its result is recorded, so two pages racing for the last room do not both inline", async () => {
		const { record, show } = session(tempDir);
		const pageSize = MAX_HANDED_PAGE_CHARACTERS - 100_000;
		for (let index = 0; index < 2; index++) {
			const { result } = await show(`call-${index}`, pageInlinedTo(tempDir, `page-${index}`, pageSize).html);
			record(`call-${index}`, result);
		}

		const racing = await Promise.all(
			[2, 3].map((index) => show(`call-${index}`, pageInlinedTo(tempDir, `page-${index}`, pageSize).html)),
		);

		expect(racing.map(({ result }) => result.details.imagesInlined).sort()).toEqual([false, true]);
	});

	it("inlines a path the page loads and leaves the same path mentioned in text as written", async () => {
		const chart = join(tempDir, "chart.png");
		writeFileSync(chart, PNG_HEAD);
		const html = `<p>Saved to <code>"${chart}"</code></p><img src="${chart}">`;

		const { result } = await session(tempDir).show("call-mixed", html);

		expect(result.details.html).toBe(
			`<p>Saved to <code>"${chart}"</code></p><img src="${DATA_PREFIX}${PNG_HEAD.toString("base64")}">`,
		);
	});

	it("never reads an image only mentioned in text, so a mentioned file over the image limit does not refuse the page", async () => {
		const big = join(tempDir, "big.png");
		writeFileSync(big, Buffer.concat([PNG_HEAD, Buffer.alloc(11 * 1024 * 1024, 1)]));
		const html = `<pre>const shot = "${big}";</pre>`;

		const { result } = await session(tempDir).show("call-big-mention", html);

		expect(result.details.html).toBe(html);
	});
});

describe("senpi#6924: the ledger of not-yet-recorded pages lives and ends with its session", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-6924-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const pageSize = MAX_HANDED_PAGE_CHARACTERS - 100_000;
	const pagesPerBudget = Math.floor(MAX_HANDED_PAGES_CHARACTERS / pageSize);

	/** Hands pages in one session without recording their results, until the budget refuses one. */
	async function fillWithUnrecordedPages(show: ReturnType<typeof session>["show"]) {
		for (let index = 0; index < pagesPerBudget; index++) {
			const { result } = await show(`fill-${index}`, pageInlinedTo(tempDir, `fill-${index}`, pageSize).html);
			expect(result.details.imagesInlined).toBe(true);
		}
		const { result } = await show("refused", pageInlinedTo(tempDir, "refused", pageSize).html);
		expect(result.details.imagesInlined).toBe(false);
	}

	it.each(["agent_end", "session_shutdown"])(
		"forgets pages handed but never recorded once %s fires, without another show_html_page call",
		async (event) => {
			const extension = loadExtension();
			const { show } = session(tempDir, extension.tool);
			await fillWithUnrecordedPages(show);

			extension.emit(event);

			const { result } = await show("after", pageInlinedTo(tempDir, "after", pageSize).html);
			expect(result.details.imagesInlined).toBe(true);
		},
	);

	it("keeps no ledger across session runtimes on one host: a new runtime for the same session starts empty", async () => {
		const sessionId = randomUUID();
		const first = loadExtension();
		await fillWithUnrecordedPages(session(tempDir, first.tool, sessionId).show);

		const runtimes = Array.from({ length: 10 }, () => loadExtension());
		const outcomes = await Promise.all(
			runtimes.map(async (runtime, index) => {
				const { show } = session(tempDir, runtime.tool, sessionId);
				const { result } = await show(`next-${index}`, pageInlinedTo(tempDir, `next-${index}`, pageSize).html);
				return result.details.imagesInlined;
			}),
		);

		expect(outcomes.every(Boolean)).toBe(true);
	});
});
