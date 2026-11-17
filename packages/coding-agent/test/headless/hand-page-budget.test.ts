// senpi#6921: a hand runs show_html_page without the brain session's transcript. The brain applies the session's page
// budget to each page the hand hands back (the ToolHost the hand selection installs), and the hand reports what the
// brain session's host does with the page, from the prompt surface the brain sends with each call.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, ToolHost } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_HANDED_PAGE_CHARACTERS } from "../../src/core/extensions/builtin/html-render/handed-pages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHandSelection, type HandRow } from "../../src/modes/headless/hand-selection.ts";
import { cleanupHands, handDirs, openLink, startHand, toolCall } from "../hand/remote-hand-fixture.ts";

const ROW: HandRow = { device: "dev-b", label: "Studio", platform: "linux", reachable: true };
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PAGE_SIZE = MAX_HANDED_PAGE_CHARACTERS - 100_000;
const SHOWN = "The page was shown to the reader inline above your reply.";

/** `details` of a show_html_page result, as the brain received it. */
const pageDetails = (details: unknown): { imagesInlined?: unknown; html?: unknown } =>
	typeof details === "object" && details !== null ? details : {};

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
	it("holds the hand's pages to the session's page budget and reports the brain session's surface", async () => {
		const dirs = await handDirs("page-budget");
		const selection = createHandSelection({
			list: () => [ROW],
			link: () => {
				const link = openLink();
				startHand(link, dirs, []);
				return { transport: link.brain, placement: "split-local" };
			},
		});
		const session = {
			agent: { toolHost: undefined as ToolHost | undefined },
			isStreaming: false,
			sessionManager: SessionManager.inMemory(dirs.cwd),
			promptSurface: "app" as const,
		};
		expect(selection.select("s-6921", session, ROW.device)).toEqual({ ok: true });
		const calls = [0, 1, 2, 3].map((index) => {
			const path = join(dirs.cwd, `page-${index}.png`);
			writeFileSync(
				path,
				Buffer.concat([PNG_HEAD, Buffer.alloc(Math.floor(PAGE_SIZE / 4) * 3 - PNG_HEAD.length, 7)]),
			);
			return toolCall(`page-${index}`, "show_html_page", { html: `<img src="${path}">`, title: `page ${index}` });
		});
		const events: AgentEvent[] = [];

		const { messages } = await (session.agent.toolHost ?? fail()).execute(
			{ scope: { id: `scope-${crypto.randomUUID()}`, root: dirs.cwd }, calls, mode: "sequential" },
			{ emit: (event) => void events.push(event) },
		);

		const ended = events.flatMap((event) => (event.type === "tool_execution_end" ? [event.result] : []));
		const recorded = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
		);
		const expected = [true, true, true, false];
		expect(messages.map((message) => pageDetails(message.details).imagesInlined)).toEqual(expected);
		expect(ended.map((result) => pageDetails(result.details).imagesInlined)).toEqual(expected);
		expect(recorded.map((message) => pageDetails(message.details).imagesInlined)).toEqual(expected);
		expect(pageDetails(messages[3]?.details).html).toBe(calls[3]?.arguments.html);
		const texts = messages.map((message) =>
			message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		);
		expect(texts.every((text) => text.startsWith(SHOWN))).toBe(true);
		expect(texts[3]).toContain("this session's pages already carry");
	});
});

function fail(): never {
	throw new Error("the hand selection installed no ToolHost");
}
