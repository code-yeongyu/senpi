import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelsDocs = read("../docs/models.md");
const aiChanges = read("../../ai/src/tool-call-middleware/changes.md");
const aiChangelog = read("../../ai/CHANGELOG.md");
const codingChanges = read("../src/changes.md");
const codingChangelog = read("../CHANGELOG.md");

describe("Claude XML tool-call recovery documentation", () => {
	it("documents canonical default opt-out opt-in and mutual exclusion examples", () => {
		const configs = jsonExamples(modelsDocs).filter((value) =>
			JSON.stringify(value).includes("recoverTextToolCalls"),
		);
		expect(configs).toHaveLength(2);

		const customOptIn = configs.find((value) => {
			const providers = object(object(value).providers);
			const provider = object(providers["custom-proxy"]);
			const models = array(provider.models);
			return models.some((model) => object(model).id === "model-without-claude-name");
		});
		const overrideOptOut = configs.find((value) => {
			const providers = object(object(value).providers);
			const provider = object(providers.anthropic);
			return object(object(provider.modelOverrides)["anthropic/claude-sonnet-4"]).recoverTextToolCalls === false;
		});

		expect(customOptIn).toBeDefined();
		expect(overrideOptOut).toBeDefined();
		expect(modelsDocs).toContain("/(^|[^a-z0-9])claude([^a-z0-9]|$)/i");

		const precedence = markdownTable(modelsDocs, "### Recovery activation precedence");
		expect(precedence.map((row) => row.Result)).toEqual(["Disabled", "Configured boolean", "Claude ID default"]);
		expect(precedence[0]?.Condition).toContain("text tool-call protocol");
	});

	it("rejects claims of historical thinking provider-native or generic XML recovery", () => {
		const scope = markdownTable(modelsDocs, "### Recovery scan boundaries");
		expect(scope).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ Content: "Ordinary assistant text", Scanned: "Yes" }),
				expect.objectContaining({ Content: "Thinking and redacted thinking", Scanned: "No" }),
				expect.objectContaining({ Content: "Provider-native and native tool-call blocks", Scanned: "No" }),
				expect.objectContaining({ Content: "Historical persisted messages", Scanned: "No" }),
			]),
		);
		expect(modelsDocs).toContain("bare `invoke`/`parameter`/`function_calls`");
		expect(modelsDocs).toContain("exact lowercase `antml:` variants");
		for (const forbidden of [
			"Historical messages are rewritten",
			"Thinking blocks are scanned",
			"Provider-native blocks are scanned",
			"Arbitrary XML namespaces are recovered",
		]) {
			expect(modelsDocs).not.toContain(forbidden);
		}
	});

	it("documents abort and late-ID-collision fail-closed behavior", () => {
		const outcomes = markdownTable(modelsDocs, "### Recovery outcomes");
		expect(outcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ Condition: "Complete valid call", Outcome: "Execute once" }),
				expect.objectContaining({ Condition: "Incomplete or invalid call", Outcome: "Do not execute" }),
				expect.objectContaining({ Condition: "Caller abort", Outcome: "Interrupted; do not execute" }),
				expect.objectContaining({ Condition: "Late native ID collision", Outcome: "Fail closed; do not execute" }),
			]),
		);
	});

	it("records the behavior on every public and fork-facing surface", () => {
		for (const source of [aiChanges, aiChangelog, codingChanges, codingChangelog]) {
			expect(source.toLowerCase()).toContain("text tool-call recovery");
			expect(source.toLowerCase()).toContain("claude");
		}
		expect(aiChangelog.indexOf("text tool-call recovery")).toBeLessThan(aiChangelog.indexOf("## [2026."));
		expect(codingChangelog.indexOf("text tool-call recovery")).toBeLessThan(codingChangelog.indexOf("## [2026."));
	});
});

function read(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function jsonExamples(markdown: string): unknown[] {
	return [...markdown.matchAll(/```json\n([\s\S]*?)\n```/gu)].flatMap((match) => {
		try {
			return [JSON.parse(match[1] ?? "")];
		} catch {
			return [];
		}
	});
}

function markdownTable(markdown: string, heading: string): Record<string, string>[] {
	const start = markdown.indexOf(heading);
	if (start < 0) return [];
	const lines = markdown
		.slice(start + heading.length)
		.trimStart()
		.split("\n");
	const header = tableCells(lines[0] ?? "");
	if (header.length === 0 || !lines[1]?.includes("---")) return [];
	const rows: Record<string, string>[] = [];
	for (const line of lines.slice(2)) {
		if (!line.startsWith("|")) break;
		const values = tableCells(line);
		rows.push(Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
	}
	return rows;
}

function tableCells(line: string): string[] {
	if (!line.startsWith("|")) return [];
	return line
		.slice(1, -1)
		.split("|")
		.map((value) => value.trim());
}

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
