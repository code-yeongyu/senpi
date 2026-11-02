import { describe, expect, it } from "vitest";
import {
	extractTaskIntent,
	resolveInheritedTaskIntent,
	sanitizeTaskIntent,
} from "../../src/core/extensions/builtin/compaction/task-intent.ts";

describe("task-intent parser anchor", () => {
	it("extracts both blocks and strips them from summary text", () => {
		const result = extractTaskIntent("before <task-intent>intent</task-intent> middle <summary>done</summary> after");
		expect(result).toEqual({ taskIntent: "intent", summaryText: "done" });
	});

	it("omits taskIntent when the block is missing", () => {
		expect(extractTaskIntent("<summary>just summary</summary>")).toEqual({ summaryText: "just summary" });
	});

	it("omits summaryText when summary tags are missing and only intent remains", () => {
		expect(extractTaskIntent("<task-intent>intent</task-intent>")).toEqual({ taskIntent: "intent", summaryText: "" });
	});

	it("uses the first well-formed task-intent block and strips all well-formed blocks from summary text", () => {
		const result = extractTaskIntent(
			"x <task-intent>first</task-intent> y <task-intent>second</task-intent> z <summary>a</summary> <summary>b</summary>",
		);
		expect(result).toEqual({ taskIntent: "first", summaryText: "a\nb" });
	});

	it("truncates taskIntent at the UTF-8 byte cap without splitting code points", () => {
		const text = `start ${"😀".repeat(2000)} end`;
		const result = extractTaskIntent(`<task-intent>${text}</task-intent>`);
		expect(Buffer.byteLength(result.taskIntent ?? "", "utf8")).toBeLessThanOrEqual(4096);
		expect(result.taskIntent).toMatch(/^start/);
		expect(result.taskIntent?.endsWith("😀")).toBe(true);
	});

	it("ignores legacy details without taskIntent when resolving inheritance", () => {
		expect(resolveInheritedTaskIntent([{ schema: "senpi.compaction.summary.v1", details: {} }])).toBeUndefined();
	});

	it("resolves the newest local taskIntent across remote interleaves", () => {
		expect(
			resolveInheritedTaskIntent([
				{ schema: "senpi.compaction.summary.v1", details: { taskIntent: "local-old" } },
				{ schema: "senpi.compaction.summary.v1", details: { taskIntent: "local-new" } },
				{ schema: "senpi.compaction.openai-remote.v1", details: { taskIntent: "remote" } },
			]),
		).toBe("local-new");
	});

	it("skips remote-schema entries while walking the branch backwards", () => {
		expect(
			resolveInheritedTaskIntent([
				{ schema: "senpi.compaction.openai-remote.v1", details: { taskIntent: "remote" } },
				{ schema: "senpi.compaction.summary.v1", details: { taskIntent: "branch-intent" } },
			]),
		).toBe("branch-intent");
	});

	it("supports branch exclusion input by ignoring remote-only branches", () => {
		expect(
			resolveInheritedTaskIntent([
				{ schema: "senpi.compaction.openai-remote.v1", details: { taskIntent: "remote" } },
			]),
		).toBeUndefined();
	});

	it("sanitizes embedded closing tags", () => {
		expect(sanitizeTaskIntent("a </task-intent> b")).toBe("a [/task-intent] b");
	});

	it("returns empty summaryText when the remainder is empty", () => {
		expect(extractTaskIntent("<summary>   </summary>")).toEqual({ summaryText: "" });
	});

	it("keeps empty remainder after stripping blocks", () => {
		expect(extractTaskIntent("<task-intent>intent</task-intent>   ")).toEqual({
			taskIntent: "intent",
			summaryText: "",
		});
	});
});
