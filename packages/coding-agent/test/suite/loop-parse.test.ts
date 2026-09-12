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

	it("parses stop with implicit target", () => {
		const result = parseLoopArgs("stop");
		expect(result.kind).toBe("stop");
		if (result.kind !== "stop") throw new Error("type guard");
		expect(result.target).toEqual({ type: "implicit" });
	});

	it("parses stop all", () => {
		const result = parseLoopArgs("stop all");
		expect(result.kind).toBe("stop");
		if (result.kind !== "stop") throw new Error("type guard");
		expect(result.target).toEqual({ type: "all" });
	});

	it("parses stop with id", () => {
		const result = parseLoopArgs("stop 84dabc");
		expect(result.kind).toBe("stop");
		if (result.kind !== "stop") throw new Error("type guard");
		expect(result.target).toEqual({ type: "id", id: "84dabc" });
	});

	it("parses status", () => {
		const result = parseLoopArgs("status");
		expect(result.kind).toBe("status");
	});

	it("parses pause with implicit target", () => {
		const result = parseLoopArgs("pause");
		expect(result.kind).toBe("pause");
		if (result.kind !== "pause") throw new Error("type guard");
		expect(result.target).toEqual({ type: "implicit" });
	});

	it("parses pause with id", () => {
		const result = parseLoopArgs("pause 84dabc");
		expect(result.kind).toBe("pause");
		if (result.kind !== "pause") throw new Error("type guard");
		expect(result.target).toEqual({ type: "id", id: "84dabc" });
	});

	it("parses pause all", () => {
		const result = parseLoopArgs("pause all");
		expect(result.kind).toBe("pause");
		if (result.kind !== "pause") throw new Error("type guard");
		expect(result.target).toEqual({ type: "all" });
	});

	it("parses resume with implicit target", () => {
		const result = parseLoopArgs("resume");
		expect(result.kind).toBe("resume");
		if (result.kind !== "resume") throw new Error("type guard");
		expect(result.target).toEqual({ type: "implicit" });
	});

	it("parses resume with id", () => {
		const result = parseLoopArgs("resume 84dabc");
		expect(result.kind).toBe("resume");
		if (result.kind !== "resume") throw new Error("type guard");
		expect(result.target).toEqual({ type: "id", id: "84dabc" });
	});

	it("parses resume all", () => {
		const result = parseLoopArgs("resume all");
		expect(result.kind).toBe("resume");
		if (result.kind !== "resume") throw new Error("type guard");
		expect(result.target).toEqual({ type: "all" });
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
