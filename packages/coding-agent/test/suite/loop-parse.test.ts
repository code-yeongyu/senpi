import { describe, expect, it } from "vitest";
import { parseLoopArgs } from "../../src/core/extensions/builtin/loop/parse.ts";

describe("parseLoopArgs", () => {
	it("parses leading interval token", () => {
		const result = parseLoopArgs("5m /babysit-prs");
		expect(result.kind).toBe("fixed");
		if (result.kind !== "fixed") throw new Error("type guard");
		expect(result.interval).toEqual({ value: 5, unit: "m", raw: "5m" });
		expect(result.prompt).toBe("/babysit-prs");
	});

	it("parses trailing every clause", () => {
		const result = parseLoopArgs("check the deploy every 20m");
		expect(result.kind).toBe("fixed");
		if (result.kind !== "fixed") throw new Error("type guard");
		expect(result.interval).toEqual({ value: 20, unit: "m", raw: "20m" });
		expect(result.prompt).toBe("check the deploy");
	});

	it("parses trailing every clause with unit word", () => {
		const result = parseLoopArgs("run tests every 5 minutes");
		expect(result.kind).toBe("fixed");
		if (result.kind !== "fixed") throw new Error("type guard");
		expect(result.interval).toEqual({ value: 5, unit: "m", raw: "5m" });
		expect(result.prompt).toBe("run tests");
	});

	it("uses dynamic mode when no interval", () => {
		const result = parseLoopArgs("check the deploy");
		expect(result.kind).toBe("dynamic");
		if (result.kind !== "dynamic") throw new Error("type guard");
		expect(result.prompt).toBe("check the deploy");
	});

	it("does not treat 'check every PR' as an interval", () => {
		const result = parseLoopArgs("check every PR");
		expect(result.kind).toBe("dynamic");
		if (result.kind !== "dynamic") throw new Error("type guard");
		expect(result.prompt).toBe("check every PR");
	});

	it("parses bare interval-only invocation", () => {
		const result = parseLoopArgs("5m");
		expect(result.kind).toBe("bare");
		if (result.kind !== "bare") throw new Error("type guard");
		expect(result.interval).toEqual({ value: 5, unit: "m", raw: "5m" });
	});

	it("parses empty invocation as bare", () => {
		const result = parseLoopArgs("");
		expect(result.kind).toBe("bare");
		if (result.kind !== "bare") throw new Error("type guard");
		expect(result.interval).toBeUndefined();
	});

	it("rejects zero amount", () => {
		const result = parseLoopArgs("0m x");
		expect(result.kind).toBe("invalid");
		if (result.kind !== "invalid") throw new Error("type guard");
		expect(result.reason).toMatch(/zero/i);
	});

	it.each([
		["stop", "stop", { type: "implicit" }],
		["stop all", "stop", { type: "all" }],
		["stop 84dabc", "stop", { type: "id", id: "84dabc" }],
		["pause", "pause", { type: "implicit" }],
		["pause all", "pause", { type: "all" }],
		["pause 84dabc", "pause", { type: "id", id: "84dabc" }],
		["resume", "resume", { type: "implicit" }],
		["resume all", "resume", { type: "all" }],
		["resume 84dabc", "resume", { type: "id", id: "84dabc" }],
	] as const)("parses %s", (args, kind, target) => {
		// Given the command arguments and expected parsed target above.
		// When the native parser handles this invocation.
		const result = parseLoopArgs(args);

		// Then both command routing and the complete target are preserved.
		expect(result).toEqual({ kind, target, originalArgs: args });
	});
	it("parses status", () => {
		const result = parseLoopArgs("status");
		expect(result.kind).toBe("status");
	});

	it("preserves inner spacing of the prompt", () => {
		const result = parseLoopArgs("2h  spaced   prompt");
		expect(result.kind).toBe("fixed");
		if (result.kind !== "fixed") throw new Error("type guard");
		expect(result.interval).toEqual({ value: 2, unit: "h", raw: "2h" });
		expect(result.prompt).toBe("spaced   prompt");
	});

	it("leading interval wins over trailing every clause", () => {
		const result = parseLoopArgs("5m check every 20m");
		expect(result.kind).toBe("fixed");
		if (result.kind !== "fixed") throw new Error("type guard");
		expect(result.interval).toEqual({ value: 5, unit: "m", raw: "5m" });
		expect(result.prompt).toBe("check every 20m");
	});

	it("preserves prompt case and punctuation", () => {
		const result = parseLoopArgs("1d Check THE Deploy!");
		expect(result.kind).toBe("fixed");
		if (result.kind !== "fixed") throw new Error("type guard");
		expect(result.prompt).toBe("Check THE Deploy!");
	});

	it("rejects zero in trailing every clause", () => {
		const result = parseLoopArgs("x every 0 seconds");
		expect(result.kind).toBe("invalid");
		if (result.kind !== "invalid") throw new Error("type guard");
		expect(result.reason).toMatch(/zero/i);
	});

	it("accepts all supported unit aliases in trailing every clauses", () => {
		const units: Array<[string, "s" | "m" | "h" | "d"]> = [
			["1s", "s"],
			["1sec", "s"],
			["1secs", "s"],
			["1second", "s"],
			["1seconds", "s"],
			["1m", "m"],
			["1min", "m"],
			["1mins", "m"],
			["1minute", "m"],
			["1minutes", "m"],
			["1h", "h"],
			["1hr", "h"],
			["1hrs", "h"],
			["1hour", "h"],
			["1hours", "h"],
			["1d", "d"],
			["1day", "d"],
			["1days", "d"],
		];
		for (const [raw, unit] of units) {
			const result = parseLoopArgs(`task every ${raw}`);
			expect(result.kind).toBe("fixed");
			if (result.kind !== "fixed") throw new Error(`type guard for ${raw}`);
			expect(result.interval.unit).toBe(unit);
			expect(result.interval.value).toBe(1);
		}
	});

	it("keeps the original argument string on parsed results", () => {
		const raw = "5m /babysit-prs";
		const result = parseLoopArgs(raw);
		expect("originalArgs" in result ? result.originalArgs : undefined).toBe(raw);
	});
});
