// senpi#6921: a hand runs show_html_page without the brain session's transcript. The brain applies the session's page
// budget to each page the hand hands back (the ToolHost the hand selection installs), and the hand reports what the
// brain session's host does with the page, from the prompt surface the brain sends with each call. senpi#6928: an
// over-budget page keeps what the hand's tool_result handlers added, and the brain's ledger of pages it let through
// ends with the session's link to the hand, whether or not the brain loads html-render (these brains never do).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ToolHost } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { MAX_HANDED_PAGE_CHARACTERS } from "../../src/extensions/html-render/handed-pages.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHandSelection, type HandRow } from "../../src/modes/headless/hand-selection.ts";
import { cleanupHands, type HandDirs, handDirs, openLink, startHand, toolCall } from "../hand/remote-hand-fixture.ts";

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

/** A brain session (surface "app", no html-render loaded; the hand runs it) and the hand selection that links it to an in-process hand. */
function brainOnHand(dirs: HandDirs) {
	const selection = createHandSelection({
		list: () => [ROW],
		link: () => {
			const link = openLink();
			startHand(link, dirs, [...builtInExtensions, handNote]);
			return { transport: link.brain, placement: "split-local" };
		},
	});
	const session = {
		agent: { toolHost: undefined as ToolHost | undefined },
		isStreaming: false,
		sessionManager: SessionManager.inMemory(dirs.cwd),
		promptSurface: "app" as const,
	};
	return { selection, session };
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

	it("forgets the pages a session's link let through once the session is released", async () => {
		const dirs = await handDirs("page-ledger");
		const { selection, session } = brainOnHand(dirs);
		expect(selection.select(SESSION_ID, session, ROW.device)).toEqual({ ok: true });
		// Three pages fill the budget; none is recorded, as when the run is aborted before its results are written.
		await run(session.agent.toolHost, dirs.cwd, pages(dirs, "aborted", 3));

		selection.release(SESSION_ID);
		selection.restore(SESSION_ID, session);
		const { messages } = await run(session.agent.toolHost, dirs.cwd, pages(dirs, "after", 1));

		expect(messages.map((message) => pageDetails(message.details).imagesInlined)).toEqual([true]);
	});
});
