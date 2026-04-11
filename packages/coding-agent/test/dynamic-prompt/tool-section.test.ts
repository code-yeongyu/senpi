import { describe, expect, test } from "vitest";
import { buildToolSection } from "../../src/core/dynamic-prompt/tool-section.js";
import type { AvailableTool } from "../../src/core/dynamic-prompt/types.js";

describe("buildToolSection", () => {
	test("groups tools by category", () => {
		const tools: AvailableTool[] = [
			{ name: "grep", category: "search" },
			{ name: "glob", category: "search" },
			{ name: "read", category: "other" },
			{ name: "bash", category: "other" },
		];
		const result = buildToolSection({
			tools,
			toolSnippets: {
				grep: "Search file contents",
				glob: "Find files by pattern",
				read: "Read file contents",
				bash: "Execute shell commands",
			},
		});

		expect(result).toContain("Search");
		expect(result).toContain("grep");
		expect(result).toContain("glob");
	});

	test("includes tool snippets as descriptions", () => {
		const tools: AvailableTool[] = [{ name: "read", category: "other" }];
		const result = buildToolSection({
			tools,
			toolSnippets: { read: "Read file contents with offset/limit" },
		});

		expect(result).toContain("Read file contents with offset/limit");
	});

	test("omits tools without snippets", () => {
		const tools: AvailableTool[] = [
			{ name: "read", category: "other" },
			{ name: "secret_tool", category: "other" },
		];
		const result = buildToolSection({
			tools,
			toolSnippets: { read: "Read file contents" },
		});

		expect(result).toContain("read");
		expect(result).not.toContain("secret_tool");
	});

	test("returns minimal output for empty tools", () => {
		const result = buildToolSection({ tools: [], toolSnippets: {} });

		expect(result).toContain("(none)");
	});

	test("includes guidelines section", () => {
		const tools: AvailableTool[] = [
			{ name: "bash", category: "other" },
			{ name: "grep", category: "search" },
		];
		const result = buildToolSection({
			tools,
			toolSnippets: { bash: "Execute commands", grep: "Search contents" },
			promptGuidelines: ["Always prefer grep over bash for file search"],
		});

		expect(result).toContain("Always prefer grep over bash for file search");
	});
});
