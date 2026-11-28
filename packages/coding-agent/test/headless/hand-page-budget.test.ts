// senpi#6921: a hand runs show_html_page without the brain session's transcript. The brain applies the session's page
// budget to each page the hand hands back (the ToolHost the hand selection installs), and the hand reports what the
// brain session's host does with the page, from the prompt surface the brain sends with each call. senpi#6928: an
// over-budget page keeps what the hand's tool_result handlers added, and the brain's ledger of pages it let through
// ends with the session's link to the hand, whether or not the brain loads html-render (these brains never do).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentEvent, ToolHost } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { MAX_HANDED_PAGE_CHARACTERS } from "../../src/extensions/html-render/handed-pages.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHandSelection, type HandRow } from "../../src/modes/headless/hand-selection.ts";
import { cleanupHands, type HandDirs, handDirs, openLink, startHand, toolCall } from "../hand/remote-hand-fixture.ts";

type AgentListener = Parameters<Agent["subscribe"]>[0];

const ROW: HandRow = { device: "dev-b", label: "Studio", platform: "linux", reachable: true };
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PAGE_SIZE = MAX_HANDED_PAGE_CHARACTERS - 100_000;
const SHOWN = "The page was shown to the reader inline above your reply.";
const SESSION_ID = "s-6921";

/** `details` of a show_html_page result, as the brain received it. */
const pageDetails = (details: unknown): { imagesInlined?: unknown; html?: unknown } =>
	typeof details === "object" && details !== null ? details : {};

/** A hand-side extension whose tool_result handler appends a note to each page's result. */
function handNote(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) =>
		event.toolName === "show_html_page"
			? { content: [...event.content, { type: "text", text: `HAND-NOTE ${event.toolCallId}` }] }
			: undefined,
	);
}

/** A hand-side extension whose tool_result handler rewrites the page's own text so it no longer names the saved copy. */
function handRewrite(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) =>
		event.toolName === "show_html_page"
			? {
					content: event.content.map((part, index) =>
						index === 0 && part.type === "text"
							? { type: "text", text: "REWRITTEN: Local images were inlined." }
							: part,
					),
				}
			: undefined,
	);
}

/** A hand-side extension whose tool_result handler puts a note in front of each page's own text. */
function handPrepend(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) =>
		event.toolName === "show_html_page"
			? { content: [{ type: "text", text: `HAND-FIRST ${event.toolCallId}` }, ...event.content] }
			: undefined,
	);
}

/** A hand-side extension that drops `details.resultText`, as a hand on a version before senpi#6936 reports a page. */
function handBeforeResultText(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) =>
		event.toolName === "show_html_page"
			? {
					details: Object.fromEntries(
						Object.entries(Object(event.details)).filter(([key]) => key !== "resultText"),
					),
				}
			: undefined,
	);
}

/** A hand-side extension that puts a note quoting the page's saved path in front of the page text (senpi#7060). */
function handPrependSavedAt(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (event.toolName !== "show_html_page") return undefined;
		const path = Reflect.get(Object(event.details), "path");
		return { content: [{ type: "text", text: `HAND-SAVED-AT ${String(path)}` }, ...event.content] };
	});
}

/** A hand-side extension that leaves an older hand's result with no text part at all: one image, no `resultText`. */
function olderHandImageOnly(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) =>
		event.toolName === "show_html_page"
			? {
					content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
					details: Object.fromEntries(
						Object.entries(Object(event.details)).filter(([key]) => key !== "resultText"),
					),
				}
			: undefined,
	);
}

/**
 * A brain session (surface "app", no html-render loaded; the hand runs it) and the hand selection that links it to an
 * in-process hand running the built-ins and `handExtensions`. `endRun` delivers the `agent_end` a run of the session
 * would; `listeners` counts who listens for it.
 */
function brainOnHand(dirs: HandDirs, handExtensions: ((pi: ExtensionAPI) => void)[] = [handNote]) {
	const selection = createHandSelection({
		list: () => [ROW],
		link: () => {
			const link = openLink();
			startHand(link, dirs, [...builtInExtensions, ...handExtensions]);
			return { transport: link.brain, placement: "split-local" };
		},
	});
	const listeners = new Set<AgentListener>();
	const session = {
		agent: {
			toolHost: undefined as ToolHost | undefined,
			subscribe: (listener: AgentListener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		isStreaming: false,
		sessionManager: SessionManager.inMemory(dirs.cwd),
		promptSurface: "app" as const,
	};
	const endRun = () => {
		for (const listener of listeners)
			void listener({ type: "agent_end", messages: [] }, new AbortController().signal);
	};
	return { selection, session, endRun, listeners };
}

function pages(dirs: HandDirs, prefix: string, count: number): ToolCall[] {
	return Array.from({ length: count }, (_, index) => {
		const path = join(dirs.cwd, `${prefix}-${index}.png`);
		writeFileSync(path, Buffer.concat([PNG_HEAD, Buffer.alloc(Math.floor(PAGE_SIZE / 4) * 3 - PNG_HEAD.length, 7)]));
		return toolCall(`${prefix}-${index}`, "show_html_page", {
			html: `<img src="${path}">`,
			title: `${prefix} ${index}`,
		});
	});
}

async function run(host: ToolHost | undefined, root: string, calls: ToolCall[], events: AgentEvent[] = []) {
	if (host === undefined) throw new Error("the hand selection installed no ToolHost");
	return host.execute(
		{ scope: { id: `scope-${crypto.randomUUID()}`, root }, calls, mode: "sequential" },
		{ emit: (event) => void events.push(event) },
	);
}

let savedSurface: string | undefined;
beforeEach(() => {
	savedSurface = process.env.SENPI_PROMPT_SURFACE;
	delete process.env.SENPI_PROMPT_SURFACE;
});
afterEach(async () => {
	if (savedSurface === undefined) delete process.env.SENPI_PROMPT_SURFACE;
	else process.env.SENPI_PROMPT_SURFACE = savedSurface;
	await cleanupHands();
});

describe("senpi#6921: show_html_page on a hand, seen from the brain session", () => {
	it("holds the hand's pages to the session's page budget, keeps the hand's additions, and reports the brain's surface", async () => {
		const dirs = await handDirs("page-budget");
		const { selection, session } = brainOnHand(dirs);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });
		const calls = pages(dirs, "page", 4);
		const events: AgentEvent[] = [];

		const { messages } = await run(session.agent.toolHost, dirs.cwd, calls, events);

		const ended = events.flatMap((event) => (event.type === "tool_execution_end" ? [event.result] : []));
		const recorded = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
		);
		const expected = [true, true, true, false];
		expect(messages.map((message) => pageDetails(message.details).imagesInlined)).toEqual(expected);
		expect(ended.map((result) => pageDetails(result.details).imagesInlined)).toEqual(expected);
		expect(recorded.map((message) => pageDetails(message.details).imagesInlined)).toEqual(expected);
		expect(pageDetails(messages[3]?.details).html).toBe(calls[3]?.arguments.html);
		const parts = messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")));
		expect(parts.every((texts) => texts[0]?.startsWith(SHOWN))).toBe(true);
		expect(parts.map((texts) => texts[1])).toEqual(calls.map((call) => `HAND-NOTE ${call.id}`));
		expect(parts[3]?.[0]).toContain("this session's pages already carry");
		expect(ended[3]?.content).toEqual(messages[3]?.content);
	});

	// senpi#6932: the hand link's ledger is emptied when a run of the session ends, as the extension's is.
	it("forgets the pages an aborted run let through once that run ends", async () => {
		const dirs = await handDirs("page-run-end");
		const { selection, session, endRun } = brainOnHand(dirs);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });
		await run(session.agent.toolHost, dirs.cwd, pages(dirs, "aborted", 3));

		endRun();
		const { messages } = await run(session.agent.toolHost, dirs.cwd, pages(dirs, "next-run", 1));

		expect(messages.map((message) => pageDetails(message.details).imagesInlined)).toEqual([true]);
	});

	// senpi#6934: the page's own text is the part equal to the `details.resultText` the tool emitted.
	it("replaces the page's own text when a hand-side handler put a note in front of it", async () => {
		const dirs = await handDirs("page-prepend");
		const { selection, session } = brainOnHand(dirs, [handPrepend]);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });

		const { messages } = await run(session.agent.toolHost, dirs.cwd, pages(dirs, "prepended", 4));

		const parts = messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")));
		expect(parts[2]?.[0]).toBe("HAND-FIRST prepended-2");
		expect(parts[2]?.[1]).toMatch(/^The page was shown.*Local images were inlined\.$/);
		expect(parts[3]).toHaveLength(2);
		expect(parts[3]?.[0]).toBe("HAND-FIRST prepended-3");
		expect(parts[3]?.[1]).toContain("this session's pages already carry");
		expect(Reflect.get(Object(messages[3]?.details), "resultText")).toBe(parts[3]?.[1]);
	});

	// senpi#6936 review: a hand on an older version emits no resultText; its page text is still the one replaced.
	it("replaces the first text part of a hand result that names no resultText", async () => {
		const dirs = await handDirs("page-older-hand");
		const { selection, session } = brainOnHand(dirs, [handBeforeResultText, handNote]);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });

		const { messages } = await run(session.agent.toolHost, dirs.cwd, pages(dirs, "older", 4));

		const parts = messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")));
		expect(Reflect.get(Object(messages[2]?.details), "resultText")).toBeUndefined();
		expect(parts[2]?.[0]).toMatch(/Local images were inlined\.$/);
		expect(parts[3]).toHaveLength(2);
		expect(parts[3]?.[0]).toContain("this session's pages already carry");
		expect(parts[3]?.[0]).not.toContain("Local images were inlined.");
		expect(parts[3]?.[1]).toBe("HAND-NOTE older-3");
		expect(pageDetails(messages[3]?.details).imagesInlined).toBe(false);
	});

	// senpi#6934: a rewritten page text is no longer the tool's own, so nothing is replaced; the sentence is appended.
	it("appends the over-budget sentence and replaces nothing when a hand-side handler rewrote the page text", async () => {
		const dirs = await handDirs("page-rewrite");
		const { selection, session } = brainOnHand(dirs, [handRewrite, handNote]);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });
		const calls = pages(dirs, "rewritten", 4);

		const { messages } = await run(session.agent.toolHost, dirs.cwd, calls);

		const parts = messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")));
		expect(parts[2]).toEqual(["REWRITTEN: Local images were inlined.", "HAND-NOTE rewritten-2"]);
		expect(parts[3]).toHaveLength(3);
		expect(parts[3]?.slice(0, 2)).toEqual(["REWRITTEN: Local images were inlined.", "HAND-NOTE rewritten-3"]);
		expect(parts[3]?.[2]).toContain("this session's pages already carry");
		expect(pageDetails(messages[3]?.details)).toMatchObject({ imagesInlined: false, html: calls[3]?.arguments.html });
	});

	// senpi#6937: an older hand sends no resultText; its page text is the part naming the saved copy, not a note in front.
	it("replaces an older hand's page text, not a note a hand-side handler put in front of it", async () => {
		const dirs = await handDirs("page-older-front");
		const { selection, session } = brainOnHand(dirs, [handBeforeResultText, handPrepend]);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });

		const { messages } = await run(session.agent.toolHost, dirs.cwd, pages(dirs, "older", 4));

		const parts = messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")));
		expect(Reflect.get(Object(messages[2]?.details), "resultText")).toBeUndefined();
		expect(parts[3]).toHaveLength(2);
		expect(parts[3]?.[0]).toBe("HAND-FIRST older-3");
		expect(parts[3]?.[1]).toContain("this session's pages already carry");
		expect(pageDetails(messages[3]?.details).imagesInlined).toBe(false);
	});

	// senpi#7060: a note quoting the saved path names the path too; the page's own text is the part that also reports
	// the inlined images, so the note stays.
	it("replaces an older hand's page text, not a note in front of it that quotes the saved path", async () => {
		const dirs = await handDirs("page-older-saved-at");
		const { selection, session } = brainOnHand(dirs, [handBeforeResultText, handPrependSavedAt]);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });

		const { messages } = await run(session.agent.toolHost, dirs.cwd, pages(dirs, "saved", 4));

		const parts = messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")));
		expect(parts[3]).toHaveLength(2);
		expect(parts[3]?.[0]).toMatch(/^HAND-SAVED-AT \//);
		expect(parts[3]?.[1]).toContain("this session's pages already carry");
		expect(pageDetails(messages[3]?.details).imagesInlined).toBe(false);
	});

	// senpi#6939: with no text part at all, the over-budget sentence goes first, as the brain put it before the marker.
	it("puts the over-budget sentence first when an older hand's result has no text part", async () => {
		const dirs = await handDirs("page-no-text");
		const { selection, session } = brainOnHand(dirs, [olderHandImageOnly]);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });

		const { messages } = await run(session.agent.toolHost, dirs.cwd, pages(dirs, "imageonly", 4));

		expect(messages[2]?.content.map((part) => part.type)).toEqual(["image"]);
		const page = messages[3]?.content ?? [];
		expect(page.map((part) => part.type)).toEqual(["text", "image"]);
		expect(page[0]?.type === "text" ? page[0].text : "").toContain("this session's pages already carry");
		expect(pageDetails(messages[3]?.details).imagesInlined).toBe(false);
	});

	it("forgets the pages a session's link let through once the session is released", async () => {
		const dirs = await handDirs("page-ledger");
		const { selection, session, listeners } = brainOnHand(dirs);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });
		// Three pages fill the budget; none is recorded, as when the run is aborted before its results are written.
		await run(session.agent.toolHost, dirs.cwd, pages(dirs, "aborted", 3));

		selection.release(SESSION_ID);
		expect(listeners.size).toBe(0);
		selection.restore(SESSION_ID, session);
		const { messages } = await run(session.agent.toolHost, dirs.cwd, pages(dirs, "after", 1));

		expect(messages.map((message) => pageDetails(message.details).imagesInlined)).toEqual([true]);
	});
});
