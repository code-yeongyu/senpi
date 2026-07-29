import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
	alignFooterLine,
	buildFooterTopLeftSegments,
	buildFooterUsageSegments,
	compactWorkingDirectory,
	fitFooterSegments,
	planFooterBottomLine,
	sanitizeFooterLabel,
	sortedFooterStatuses,
} from "../../examples/extensions/two-line-footer/footer-layout.ts";
import { planFooterTopLine } from "../../examples/extensions/two-line-footer/top-line-layout.ts";

describe("planFooterBottomLine", () => {
	it("keeps extension statuses in the right-aligned footer block", () => {
		const line = planFooterBottomLine(["↑1K"], "32K/372K (8.6%)", ["quota 88%"], 40);

		expect(line).toEqual({
			left: "↑1K",
			right: "32K/372K (8.6%) • quota 88%",
		});
	});
});

describe("fitFooterSegments", () => {
	it("keeps reserved status unchanged when space is tight", () => {
		const rendered = fitFooterSegments(["32K/372K (8.6%)"], ["quota 88%"], 9);

		expect(rendered).toBe("quota 88%");
	});

	it("includes context before status when space permits", () => {
		const rendered = fitFooterSegments(["32K/372K (8.6%)"], ["quota 88%"], 40);

		expect(rendered).toBe("32K/372K (8.6%) • quota 88%");
	});

	it("drops context before overflowing a wide status", () => {
		const rendered = fitFooterSegments(["문맥"], ["상태상태"], 10);

		expect(rendered).toBe("상태상태");
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(10);
	});
});

describe("alignFooterLine", () => {
	it("places the reserved text at the right edge", () => {
		const rendered = alignFooterLine("left", "right", 24);

		expect(rendered).toBe("left               right");
	});

	it("truncates leading text before reserved text", () => {
		const rendered = alignFooterLine("very-long-left", "right", 16);

		expect(rendered).toBe("…ong-left  right");
	});

	it("measures wide glyphs by terminal columns", () => {
		const rendered = alignFooterLine("경로", "상태", 16);

		expect(visibleWidth(rendered)).toBe(16);
		expect(rendered.endsWith("상태")).toBe(true);
	});

	it("keeps a truncated wide right block at the right edge", () => {
		const rendered = alignFooterLine("", "상태상태상태", 9);

		expect(visibleWidth(rendered)).toBe(9);
	});

	it("keeps the identifying tail when a long path must shrink", () => {
		const rendered = alignFooterLine("[workspace/very-long-project/src] • main", "model", 36);

		expect(rendered.startsWith("…")).toBe(true);
		expect(rendered).toContain("project/src] • main");
		expect(rendered.endsWith("model")).toBe(true);
		expect(visibleWidth(rendered)).toBe(36);
	});
});

describe("compactWorkingDirectory", () => {
	it("keeps the last two Windows path segments", () => {
		const rendered = compactWorkingDirectory("C:\\workspace\\project\\src");

		expect(rendered).toBe("[project\\src]");
	});

	it("preserves POSIX separators", () => {
		const rendered = compactWorkingDirectory("/workspace/project/src");

		expect(rendered).toBe("[project/src]");
	});
});

describe("sortedFooterStatuses", () => {
	it("keeps the nested-agent counter on the left and other statuses on the right", () => {
		const statuses = sortedFooterStatuses(
			new Map([
				["provider", "quota 88%"],
				["fast", "fast mode"],
				["ext:nested-agents:status", "🤖 2"],
			]),
		);

		expect(statuses).toEqual({
			left: ["🤖 2"],
			right: ["fast mode", "quota 88%"],
		});
	});
});

describe("buildFooterTopLeftSegments", () => {
	it("prepends the built-in native badge only when the default footer exposes it", () => {
		const active = buildFooterTopLeftSegments({
			path: "[project/src]",
			branch: "main",
			sessionName: "",
			omoNative: true,
		});
		const inactive = buildFooterTopLeftSegments({
			path: "[project/src]",
			branch: "main",
			sessionName: "",
			omoNative: false,
		});

		expect(active.at(0)).toEqual({
			color: "success",
			kind: "badge",
			text: "(🏴‍☠️ OmO Native)",
		});
		expect(inactive.at(0)).toEqual({
			color: "accent",
			kind: "path",
			text: "[project/src]",
		});
	});
});

describe("planFooterTopLine", () => {
	it("shrinks a long path before dropping the session", () => {
		const segments = buildFooterTopLeftSegments({
			path: "[workspace/very-long-project-name/src]",
			branch: "main",
			sessionName: "work",
			omoNative: false,
		});

		const plan = planFooterTopLine({
			width: 55,
			segments,
			minimalRight: "model",
			fullRight: "(provider) model",
		});

		expect(plan.right).toBe("(provider) model");
		expect(plan.segments.some((segment) => segment.kind === "session")).toBe(true);
		expect(plan.segments.find((segment) => segment.kind === "path")?.text).toMatch(/^….*name\/src\]$/);
	});

	it("drops the session before shrinking a short path", () => {
		const segments = buildFooterTopLeftSegments({
			path: "[project/src]",
			branch: "main",
			sessionName: "a-very-long-session-name",
			omoNative: false,
		});

		const plan = planFooterTopLine({
			width: 42,
			segments,
			minimalRight: "model",
			fullRight: "(provider) model",
		});

		expect(plan.right).toBe("(provider) model");
		expect(plan.segments.some((segment) => segment.kind === "session")).toBe(false);
		expect(plan.segments.find((segment) => segment.kind === "path")?.text).toBe("[project/src]");
	});
});

describe("sanitizeFooterLabel", () => {
	it("removes terminal controls and forces a single line", () => {
		const rendered = sanitizeFooterLabel("\u001b]52;c;Y2xpcGJvYXJk\u0007line1\n\t\u001b[31mline2\u001b[0m\u0000");

		expect(rendered).toBe("line1 line2");
	});
});

describe("buildFooterUsageSegments", () => {
	it("formats token, cache, and subscription cost segments", () => {
		const segments = buildFooterUsageSegments(
			{
				input: 1_234,
				output: 2_000,
				cacheRead: 3_000,
				cacheWrite: 400,
				latestCacheHitRate: 87.65,
				cost: 0.1234,
			},
			true,
		);

		expect(segments).toEqual([
			{ color: "dim", text: "↑1.2K" },
			{ color: "dim", text: "↓2K" },
			{ color: "dim", text: "cache 3K/400" },
			{ color: "dim", text: "CH87.7%" },
			{ color: "success", text: "$0.123 (sub)" },
		]);
	});
});
