import { describe, expect, it } from "vitest";
import { buildEvalPrompt } from "../src/prompt/eval-prompt.ts";
import { createEvalInputSchema } from "../src/tool/types.ts";

const enabled = { py: true, js: true, rb: false, jl: false };

function descriptionOf(schema: unknown): string {
	if (typeof schema !== "object" || schema === null || !("description" in schema)) return "";
	return typeof schema.description === "string" ? schema.description : "";
}

describe("eval schema renders the configured deadlines", () => {
	it("names the configured run budget, detach point, and hard limit in the timeout fields", () => {
		const schema = createEvalInputSchema(enabled, {
			runBudgetSeconds: 45,
			detachAfterSeconds: 7,
			foregroundWindowSeconds: 9,
			hardLimitSeconds: 900,
		});

		expect(descriptionOf(schema.properties.timeout)).toContain("45s");
		expect(descriptionOf(schema.properties.timeout)).toContain("900s");
		expect(descriptionOf(schema.properties.on_timeout)).toContain("7s");
		expect(descriptionOf(schema.properties.on_timeout)).toContain("9s");
	});

	it("falls back to the package defaults when no deadlines are given", () => {
		const schema = createEvalInputSchema(enabled);

		expect(descriptionOf(schema.properties.timeout)).toContain("300s");
		expect(descriptionOf(schema.properties.timeout)).toContain("1800s");
		expect(descriptionOf(schema.properties.on_timeout)).toContain("30s");
		expect(descriptionOf(schema.properties.on_timeout)).toContain("60s");
	});
});

describe("eval description renders the configured run budget", () => {
	it("shows the configured budget and the default otherwise", () => {
		const configured = buildEvalPrompt(enabled, { spawns: false, runBudgetSeconds: 45 }).description;
		const fallback = buildEvalPrompt(enabled, { spawns: false }).description;

		expect(configured).toContain("45s");
		expect(configured).not.toContain("300s");
		expect(fallback).toContain("300s");
	});
});
