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

	test("shows lsp category when lsp tools present", () => {
		const tools: AvailableTool[] = [
			{ name: "lsp_goto_definition", category: "lsp" },
			{ name: "lsp_find_references", category: "lsp" },
		];
		const result = buildToolSection({
			tools,
			toolSnippets: {
				lsp_goto_definition: "Jump to symbol definition",
				lsp_find_references: "Find all references",
			},
		});

		expect(result).toContain("lsp_goto_definition");
		expect(result).toContain("lsp_find_references");
	});

	test("shows ast category when ast tools present", () => {
		const tools: AvailableTool[] = [{ name: "ast_grep_search", category: "ast" }];
		const result = buildToolSection({
			tools,
			toolSnippets: { ast_grep_search: "AST-aware code search" },
		});

		expect(result).toContain("ast_grep_search");
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
