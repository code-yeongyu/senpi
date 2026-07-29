import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
	alignFooterLine,
	buildFooterUsageSegments,
	compactWorkingDirectory,
	fitFooterSegments,
	planFooterBottomLine,
	sanitizeFooterLabel,
	sortedFooterStatuses,
} from "../../examples/extensions/two-line-footer/footer-layout.ts";

describe("planFooterBottomLine", () => {
	it("keeps extension statuses in the right-aligned footer block", () => {
		const line = planFooterBottomLine(["↑1K"], "32K/372K (8.6%)", ["quota 88%"], 40);

		expect(line).toEqual({
			left: "↑1K",
			right: "32K/372K (8.6%) | quota 88%",
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

		expect(rendered).toBe("32K/372K (8.6%) | quota 88%");
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

		expect(rendered).toBe("very-l...  right");
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
	it("preserves every extension status without key-specific substitution", () => {
		const statuses = sortedFooterStatuses(
			new Map([
				["provider", "quota 88%"],
				["fast", "fast mode"],
			]),
		);

		expect(statuses).toEqual(["fast mode", "quota 88%"]);
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
