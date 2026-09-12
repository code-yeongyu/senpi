import { describe, expect, it } from "vitest";
import type { GoalToolRenderDetails } from "../src/core/extensions/builtin/goal/format.ts";
import { renderGoalToolCall, renderGoalToolResult } from "../src/core/extensions/builtin/goal/renderers.ts";
import type { GoalToolSnapshot } from "../src/core/extensions/builtin/goal/types.ts";
import type { Theme, ThemeColor } from "../src/modes/interactive/theme/theme.ts";

const passthroughTheme = {
	bold: (value: string) => value,
	fg: (_key: ThemeColor, value: string) => value,
} as unknown as Theme;

function snapshot(overrides: Partial<GoalToolSnapshot> = {}): GoalToolSnapshot {
	return {
		threadId: "01a04104-22d5-7f13-be4e-ada49243a283",
		objective: "Finish X re-login for q_yeon_gyu_kim",
		status: "active",
		tokensUsed: 512,
		timeUsedSeconds: 45,
		createdAt: 1787814204,
		updatedAt: 1787814296,
		...overrides,
	};
}

function renderResultLines(
	details: GoalToolRenderDetails | undefined,
	options: { expanded?: boolean; text?: string } = {},
): string[] {
	const text = options.text ?? "{}";
	const component = renderGoalToolResult(
		{ content: [{ type: "text", text }], details },
		{ expanded: options.expanded ?? false, isPartial: false },
		passthroughTheme,
	);
	const lines = component.render(200).map((line) => line.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function renderCallLine(toolName: string, args: unknown): string {
	return renderGoalToolCall(toolName, args, passthroughTheme).render(200).join("\n").trimEnd();
}

describe("goal tool result renderer", () => {
	it("renders a blocked goal as a status header, objective preview, and blocked reason", () => {
		const lines = renderResultLines({
			goal: snapshot({
				status: "blocked",
				tokensUsed: 1838,
				timeUsedSeconds: 92,
				blockedReason: "user interrupted the turn",
				blockedAt: 1787814296,
			}),
		});
		expect(lines).toEqual([
			"■ blocked • 1.8K tokens • 1m",
			"  Finish X re-login for q_yeon_gyu_kim",
			"  ⚠ user interrupted the turn",
		]);
		expect(lines.join("\n")).not.toContain('"goal"');
	});

	it("renders an active goal happy path", () => {
		const lines = renderResultLines({ goal: snapshot() });
		expect(lines).toEqual(["● active • 512 tokens • 45s", "  Finish X re-login for q_yeon_gyu_kim"]);
	});

	it("renders a complete goal with a check glyph", () => {
		const lines = renderResultLines({
			goal: snapshot({ status: "complete", tokensUsed: 2_340_000, timeUsedSeconds: 11_100 }),
		});
		expect(lines[0]).toBe("✓ complete • 2.3M tokens • 3h 5m");
	});

	it("renders the no-goal state", () => {
		expect(renderResultLines({ goal: null })).toEqual(["No active goal is set."]);
	});

	it("collapses a multi-line objective to two lines with a more-lines marker", () => {
		const objective = ["line one", "line two", "line three", "line four", "line five"].join("\n");
		const lines = renderResultLines({ goal: snapshot({ objective, tokensUsed: 0, timeUsedSeconds: 0 }) });
		expect(lines).toEqual(["● active • 0 tokens • 0s", "  line one", "  line two", "  … +3 more lines"]);
	});

	it("expands to the full objective plus timestamps", () => {
		const objective = ["line one", "line two", "line three"].join("\n");
		const lines = renderResultLines(
			{ goal: snapshot({ objective, tokensUsed: 0, timeUsedSeconds: 0 }) },
			{ expanded: true },
		);
		expect(lines).toEqual([
			"● active • 0 tokens • 0s",
			"  line one",
			"  line two",
			"  line three",
			"  created 2026-08-27T07:03:24.000Z • updated 2026-08-27T07:04:56.000Z",
		]);
	});

	it("truncates an over-wide objective line in the collapsed view", () => {
		const objective = "x".repeat(150);
		const lines = renderResultLines({ goal: snapshot({ objective }) });
		expect(lines[1].endsWith("…")).toBe(true);
		expect(lines[1].length).toBeLessThanOrEqual(123);
		const expanded = renderResultLines({ goal: snapshot({ objective }) }, { expanded: true });
		expect(expanded[1]).toBe(`  ${objective}`);
	});

	it("appends the objective truncation notice when present", () => {
		const lines = renderResultLines({ goal: snapshot(), notice: "objective truncated; full text saved" });
		expect(lines[lines.length - 1]).toBe("  objective truncated; full text saved");
	});

	it("falls back to parsing the JSON text when details are missing", () => {
		const text = JSON.stringify({ goal: snapshot({ status: "blocked", blockedReason: "stuck" }) });
		const lines = renderResultLines(undefined, { text });
		expect(lines[0]).toBe("■ blocked • 512 tokens • 45s");
		expect(lines).toContain("  ⚠ stuck");
	});

	it("renders raw text unchanged when neither details nor parseable JSON exist", () => {
		const lines = renderResultLines(undefined, { text: "plain failure message" });
		expect(lines).toEqual(["plain failure message"]);
	});
});

describe("goal tool call renderer", () => {
	it("labels get_goal plainly", () => {
		expect(renderCallLine("get_goal", {})).toBe("get_goal");
	});

	it("previews the objective for create_goal", () => {
		expect(renderCallLine("create_goal", { objective: "Do the thing" })).toBe("create_goal Do the thing");
	});

	it("truncates multi-line create_goal objectives to the first line", () => {
		expect(renderCallLine("create_goal", { objective: "Do the thing\nand more" })).toBe("create_goal Do the thing…");
	});

	it("shows the target status and reason for update_goal", () => {
		expect(renderCallLine("update_goal", { status: "blocked", reason: "stuck" })).toBe(
			"update_goal → blocked — stuck",
		);
		expect(renderCallLine("update_goal", { status: "complete" })).toBe("update_goal → complete");
	});
});
