import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_HANDED_PAGE_CHARACTERS,
	MAX_HANDED_PAGES_CHARACTERS,
	showHtmlPageTool,
} from "../../src/core/extensions/builtin/html-render/tool.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { MAX_RPC_LINE_CHARACTERS } from "../../src/modes/rpc/jsonl.ts";

// senpi#6899, senpi#6907: the page handed to the host in `details` rides every RPC record that carries
// the result, and all of a session's pages ride together in get_messages, get_tree and agent_end. A record
// over MAX_RPC_LINE_CHARACTERS drops an attach connection, so pages are inlined only within a per-page cap
// and a per-session budget; past either, a page is handed as written.

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_PREFIX = "data:image/png;base64,";

type Result = Awaited<ReturnType<typeof showHtmlPageTool.execute>>;

/** A session that records each returned result the way the agent session appends it. */
function session(cwd: string) {
	const entries: unknown[] = [];
	const sessionId = randomUUID();
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
		const result = await showHtmlPageTool.execute(toolCallId, { html, title: "Shot" }, undefined, undefined, ctx);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return { result, text };
	};
	return { ctx, entries, record, show };
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

describe("senpi#6910: nested calls, pages handed as written, and images a script loads", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-6910-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("a call another tool makes through ctx.executeTool neither spends nor keeps the session's budget", async () => {
		const { show } = session(tempDir);
		const pageSize = MAX_HANDED_PAGE_CHARACTERS - 100_000;
		const nestedCount = Math.floor(MAX_HANDED_PAGES_CHARACTERS / pageSize) + 1;
		const nested: boolean[] = [];
		for (let index = 1; index <= nestedCount; index++) {
			const { result } = await show(`call-eval/${index}`, pageInlinedTo(tempDir, `nested-${index}`, pageSize).html);
			nested.push(result.details.imagesInlined);
		}

		const { result } = await show("call-after", pageInlinedTo(tempDir, "after", pageSize).html);

		expect(nested).toEqual(Array.from({ length: nestedCount }, () => true));
		expect(result.details.imagesInlined).toBe(true);
	});

	it("does not count a page handed as written against the budget, and hands it exactly as written", async () => {
		const { record, show } = session(tempDir);
		for (let index = 0; index < 3; index++) {
			const { html } = pageInlinedTo(tempDir, `over-${index}`, MAX_HANDED_PAGE_CHARACTERS + 4);
			const { result } = await show(`call-over-${index}`, html);
			record(`call-over-${index}`, result);
			expect(result.details).toMatchObject({ imagesInlined: false, html });
		}
		const pageSize = MAX_HANDED_PAGE_CHARACTERS - 100_000;
		const inlined: boolean[] = [];
		for (let index = 0; index < Math.floor(MAX_HANDED_PAGES_CHARACTERS / pageSize); index++) {
			const { result } = await show(`call-image-${index}`, pageInlinedTo(tempDir, `image-${index}`, pageSize).html);
			record(`call-image-${index}`, result);
			inlined.push(result.details.imagesInlined);
		}

		expect(inlined.every(Boolean)).toBe(true);
	});

	it("inlines an image a script loads from an object literal", async () => {
		const chart = join(tempDir, "chart.png");
		writeFileSync(chart, PNG_HEAD);
		const html = `<img id="shot"><script>const shot = { src: "${chart}", alt: "chart" }; document.getElementById("shot").src = shot.src;</script>`;

		const { result } = await session(tempDir).show("call-object", html);

		expect(result.details.html).toBe(html.replace(chart, DATA_PREFIX + PNG_HEAD.toString("base64")));
	});

	it("inlines every image of a path array a script assigns later", async () => {
		const first = join(tempDir, "first.png");
		const second = join(tempDir, "second.png");
		writeFileSync(first, PNG_HEAD);
		writeFileSync(second, PNG_HEAD);
		const html = `<img id="shot"><script>const shots = ['${first}', '${second}']; let at = 0; setInterval(() => { document.getElementById("shot").src = shots[at++ % shots.length]; }, 1000);</script>`;

		const { result } = await session(tempDir).show("call-array", html);

		expect(result.details.html).not.toContain(first);
		expect(result.details.html).not.toContain(second);
		expect(result.details.html.split(DATA_PREFIX)).toHaveLength(3);
	});

	it("refuses a page whose script loads a missing image, naming the path", async () => {
		const missing = join(tempDir, "missing.png");
		const html = `<script>const shots = ["${missing}"];</script>`;

		await expect(session(tempDir).show("call-missing", html)).rejects.toThrow(
			`These local images could not be read: ${missing}.`,
		);
	});

	it("leaves a missing path only mentioned in prose, a code sample or an escaped tag as written", async () => {
		const missing = join(tempDir, "missing.png");
		const html =
			`<title>"${missing}"</title><p>Saved to "${missing}".</p>` +
			`<pre><code>const shot = { src: "${missing}" };</code></pre>` +
			`<pre>&lt;img src="${missing}"&gt;</pre><!-- <img src="${missing}"> -->`;

		const { result } = await session(tempDir).show("call-mentions", html);

		expect(result.details.html).toBe(html);
	});
});
