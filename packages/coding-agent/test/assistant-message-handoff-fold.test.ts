import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { splitHandoffBlocks } from "../src/modes/interactive/components/handoff-fold.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const BLOCK =
	"Ask: fix the login redirect - wanted: users land on the dashboard. For you: the redirect now reads the saved path; 12 tests pass. Now: Post milestones and report. Next: Open the PR.";
const GPT_BLOCK =
	"Redirect fixed and the login works for every user. You need: 3/3 done, no blockers. Now: Report the fix. Next: none.";

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function plain(component: AssistantMessageComponent, width = 80): string[] {
	return component.render(width).map((line) => stripAnsi(line).replace(/\x1b\]133;[ABC]\x07/g, ""));
}

beforeAll(() => {
	initTheme("dark");
});

describe("splitHandoffBlocks", () => {
	test("a plain answer is one text segment", () => {
		const text = "The function parses the header.\n\nNow: it also checks the length.";
		expect(splitHandoffBlocks(text)).toEqual([{ kind: "text", text }]);
	});

	test("finds the block and its slots between prose paragraphs", () => {
		const segments = splitHandoffBlocks(`Intro line.\n\n${BLOCK}\n\nDetail after.`);
		expect(segments.map((segment) => segment.kind)).toEqual(["text", "handoff", "text"]);
		expect(segments[1]).toMatchObject({
			answer: "the redirect now reads the saved path; 12 tests pass.",
			now: "Post milestones and report.",
			next: "Open the PR.",
		});
	});

	test("the GPT presets' block keeps its outcome sentence as the answer", () => {
		expect(splitHandoffBlocks(GPT_BLOCK)[0]).toMatchObject({
			kind: "handoff",
			answer: "Redirect fixed and the login works for every user. 3/3 done, no blockers.",
			now: "Report the fix.",
			next: "none.",
		});
	});

	test.each([
		"You need: Node 22. Now: run install. Next: run tests.",
		"Setup is short. Next: run tests. Now: run install. You need: Node 22.",
		"For you: a gift. Now: open it. Next: say thanks.",
		"Ask: nothing. Now: rest. Next: sleep.",
	])("prose that only uses the labels stays text: %s", (text) => {
		expect(splitHandoffBlocks(text)).toEqual([{ kind: "text", text }]);
	});

	test("a For you that opens with a bullet list keeps its markers", () => {
		const text =
			"Ask: tidy up - wanted: clean tree. For you:\n- removed the temp dir\n- kept the worktree\nNow: none. Next: none.";
		expect(splitHandoffBlocks(text)[0]).toMatchObject({ answer: "- removed the temp dir\n- kept the worktree" });
	});

	test("a block still streaming stays text until Next arrives", () => {
		const partial = "Ask: fix it - wanted: fixed. For you: done. Now: a.";
		expect(splitHandoffBlocks(partial)).toEqual([{ kind: "text", text: partial }]);
	});

	test("a block inside a code fence stays text", () => {
		const text = `\`\`\`\n${BLOCK}\n\`\`\``;
		expect(splitHandoffBlocks(text)).toEqual([{ kind: "text", text }]);
	});
});

describe("AssistantMessageComponent folds the handoff block (senpi#3323)", () => {
	test("collapsed: one muted line with Now and Next, then the For you answer; no slot labels", () => {
		const lines = plain(new AssistantMessageComponent(message(BLOCK)), 60);
		const fold = lines.find((line) => line.includes("\u25B8 Handoff"));
		expect(fold).toContain("Now: Post milestones");
		expect(visibleWidth(fold ?? "")).toBeLessThanOrEqual(60);
		const rendered = lines.join("\n");
		expect(rendered).toContain("the redirect now reads the saved path");
		expect(rendered).not.toContain("Ask:");
		expect(rendered).not.toContain("For you:");
	});

	test("expand-all (Ctrl+O) shows the block as written", () => {
		const component = new AssistantMessageComponent(message(BLOCK));
		component.setExpanded(true);
		const rendered = plain(component).join("\n");
		expect(rendered).toContain("\u25BE Handoff");
		expect(rendered.replace(/\s+/g, " ")).toContain("Ask: fix the login redirect - wanted:");
	});

	test("a click on the fold line opens that block, and a second click closes it", () => {
		const component = new AssistantMessageComponent(message(BLOCK));
		const click = () => {
			const row = plain(component).findIndex((line) => line.includes("Handoff"));
			const child = (component as unknown as { contentContainer: { children: unknown[] } }).contentContainer
				.children[row] as { handleMouse?: (event: unknown) => unknown };
			return child.handleMouse?.({ type: "click", button: "left", x: 1, y: 0 });
		};
		expect(click()).toEqual({ handled: true });
		expect(plain(component).join("\n")).toContain("Ask:");
		click();
		expect(plain(component).join("\n")).not.toContain("Ask:");
	});

	test("the GPT block folds with its outcome shown as the answer", () => {
		const rendered = plain(new AssistantMessageComponent(message(GPT_BLOCK))).join("\n");
		expect(rendered).toContain("\u25B8 Handoff");
		expect(rendered).toContain("Redirect fixed and the login works for every user.");
		expect(rendered).not.toContain("You need:");
	});

	test("a block with an empty For you folds to the line alone", () => {
		const lines = plain(
			new AssistantMessageComponent(message("Ask: check - wanted: a check. For you: Now: none. Next: none.")),
		);
		expect(lines.filter((line) => line.trim() !== "")).toEqual([expect.stringContaining("\u25B8 Handoff")]);
	});

	test("an answer with no block renders unchanged", () => {
		const text = "The function parses the header and returns its length.";
		const rendered = plain(new AssistantMessageComponent(message(text))).join("\n");
		expect(rendered).toContain(text);
		expect(rendered).not.toContain("Handoff");
	});
});
