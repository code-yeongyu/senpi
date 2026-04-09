import { describe, expect, it } from "vitest";
import {
	createBuiltinParserRegistry,
	ParserRegistry,
	type PermissionRequest,
} from "../../src/core/extensions/builtin/permission-system/parsers.js";

describe("permission parsers", () => {
	describe("ParserRegistry", () => {
		it("returns tool-level fallback permission when no parser is registered", () => {
			// given
			const registry = new ParserRegistry();

			// when
			const result = registry.parse("custom_tool", {}, "/workspace/project");

			// then
			expect(result).toEqual([{ permission: "custom_tool", patterns: ["*"], always: ["*"] }]);
		});

		it("uses the registered parser for known tools", () => {
			// given
			const registry = new ParserRegistry();
			const expected: PermissionRequest[] = [{ permission: "custom", patterns: ["alpha"], always: ["beta"] }];
			registry.register("custom_tool", () => expected);

			// when
			const result = registry.parse("custom_tool", {}, "/workspace/project");

			// then
			expect(result).toBe(expected);
		});
	});

	describe("createBuiltinParserRegistry", () => {
		const cwd = "/Users/me/project";
		const registry = createBuiltinParserRegistry();

		describe("bash", () => {
			it("returns bash permission with command prefix pattern", () => {
				// given
				const input = { command: 'git commit -m "test"' };

				// when
				const result = registry.parse("bash", input, cwd);

				// then
				expect(result).toEqual([
					{ permission: "bash", patterns: ["git commit"], always: ["git commit", "git commit *"] },
				]);
			});

			it("trims repeated whitespace before parsing prefix", () => {
				// given
				const input = { command: "  docker   compose   up  -d  " };

				// when
				const result = registry.parse("bash", input, cwd);

				// then
				expect(result).toEqual([
					{
						permission: "bash",
						patterns: ["docker compose up"],
						always: ["docker compose up", "docker compose up *"],
					},
				]);
			});

			it("falls back to the first token for unknown commands", () => {
				// given
				const input = { command: "custom-script --flag value" };

				// when
				const result = registry.parse("bash", input, cwd);

				// then
				expect(result).toEqual([
					{ permission: "bash", patterns: ["custom-script"], always: ["custom-script", "custom-script *"] },
				]);
			});

			it("returns wildcard fallback when command is missing", () => {
				// given
				const input = {};

				// when
				const result = registry.parse("bash", input, cwd);

				// then
				expect(result).toEqual([{ permission: "bash", patterns: ["*"], always: ["*"] }]);
			});

			it("adds external_directory permission for one external path", () => {
				// given
				const input = { command: "cat /Users/other/project/file.txt" };

				// when
				const result = registry.parse("bash", input, cwd);

				// then
				expect(result).toEqual([
					{ permission: "bash", patterns: ["cat"], always: ["cat", "cat *"] },
					{
						permission: "external_directory",
						patterns: ["/Users/other/project/file.txt"],
						always: ["/Users/other/project/*"],
					},
				]);
			});

			it("adds one external_directory request for multiple external paths", () => {
				// given
				const input = { command: "cp /Users/other/file1.txt /Users/other/file2.txt ." };

				// when
				const result = registry.parse("bash", input, cwd);

				// then
				expect(result).toEqual([
					{ permission: "bash", patterns: ["cp"], always: ["cp", "cp *"] },
					{
						permission: "external_directory",
						patterns: ["/Users/other/file1.txt", "/Users/other/file2.txt"],
						always: ["/Users/other/*", "/Users/other/*"],
					},
				]);
			});

			it("keeps home-based external paths in the permission request", () => {
				// given
				const input = { command: "cat ~/other-project/file.txt" };

				// when
				const result = registry.parse("bash", input, "/Users/me/project");

				// then
				expect(result).toEqual([
					{ permission: "bash", patterns: ["cat"], always: ["cat", "cat *"] },
					{
						permission: "external_directory",
						patterns: ["~/other-project/file.txt"],
						always: ["~/other-project/*"],
					},
				]);
			});

			it("keeps quoted external paths in the permission request", () => {
				// given
				const input = { command: 'cat "/Users/other/project/file with spaces.txt"' };

				// when
				const result = registry.parse("bash", input, cwd);

				// then
				expect(result).toEqual([
					{ permission: "bash", patterns: ["cat"], always: ["cat", "cat *"] },
					{
						permission: "external_directory",
						patterns: ["/Users/other/project/file with spaces.txt"],
						always: ["/Users/other/project/*"],
					},
				]);
			});

			it("does not add external_directory permission for internal paths", () => {
				// given
				const input = { command: "cat ./src/index.ts" };

				// when
				const result = registry.parse("bash", input, cwd);

				// then
				expect(result).toEqual([{ permission: "bash", patterns: ["cat"], always: ["cat", "cat *"] }]);
			});
		});

		describe("edit-like tools", () => {
			it("maps edit to the unified edit permission", () => {
				// given
				const input = { path: "src/index.ts", edits: [] };

				// when
				const result = registry.parse("edit", input, cwd);

				// then
				expect(result).toEqual([{ permission: "edit", patterns: ["src/index.ts"], always: ["src/index.ts"] }]);
			});

			it("maps write to the unified edit permission", () => {
				// given
				const input = { path: "src/index.ts", content: "hello" };

				// when
				const result = registry.parse("write", input, cwd);

				// then
				expect(result).toEqual([{ permission: "edit", patterns: ["src/index.ts"], always: ["src/index.ts"] }]);
			});

			it("maps apply_patch to the unified edit permission", () => {
				// given
				const input = { file_path: "src/index.ts" };

				// when
				const result = registry.parse("apply_patch", input, cwd);

				// then
				expect(result).toEqual([{ permission: "edit", patterns: ["src/index.ts"], always: ["src/index.ts"] }]);
			});

			it("maps multiedit to the unified edit permission", () => {
				// given
				const input = { file_path: "src/index.ts" };

				// when
				const result = registry.parse("multiedit", input, cwd);

				// then
				expect(result).toEqual([{ permission: "edit", patterns: ["src/index.ts"], always: ["src/index.ts"] }]);
			});

			it("returns edit wildcard fallback when no path is present", () => {
				// given
				const input = { content: "hello" };

				// when
				const result = registry.parse("write", input, cwd);

				// then
				expect(result).toEqual([{ permission: "edit", patterns: ["*"], always: ["*"] }]);
			});
		});

		describe("read", () => {
			it("uses path for read permission requests", () => {
				// given
				const input = { path: "README.md" };

				// when
				const result = registry.parse("read", input, cwd);

				// then
				expect(result).toEqual([{ permission: "read", patterns: ["README.md"], always: ["README.md"] }]);
			});

			it("supports file_path alias for read permission requests", () => {
				// given
				const input = { file_path: "README.md" };

				// when
				const result = registry.parse("read", input, cwd);

				// then
				expect(result).toEqual([{ permission: "read", patterns: ["README.md"], always: ["README.md"] }]);
			});

			it("returns read wildcard fallback when path is missing", () => {
				// given
				const input = { offset: 10 };

				// when
				const result = registry.parse("read", input, cwd);

				// then
				expect(result).toEqual([{ permission: "read", patterns: ["*"], always: ["*"] }]);
			});
		});

		describe("grep", () => {
			it("uses path when grep path is provided", () => {
				// given
				const input = { pattern: "function", path: "src" };

				// when
				const result = registry.parse("grep", input, cwd);

				// then
				expect(result).toEqual([{ permission: "grep", patterns: ["src"], always: ["*"] }]);
			});

			it("falls back to the grep pattern when path is omitted", () => {
				// given
				const input = { pattern: "function" };

				// when
				const result = registry.parse("grep", input, cwd);

				// then
				expect(result).toEqual([{ permission: "grep", patterns: ["function"], always: ["*"] }]);
			});

			it("returns grep wildcard fallback when both path and pattern are missing", () => {
				// given
				const input = {};

				// when
				const result = registry.parse("grep", input, cwd);

				// then
				expect(result).toEqual([{ permission: "grep", patterns: ["*"], always: ["*"] }]);
			});
		});

		describe("find", () => {
			it("maps find to list permission with the provided path", () => {
				// given
				const input = { pattern: "**/*.ts", path: "src" };

				// when
				const result = registry.parse("find", input, cwd);

				// then
				expect(result).toEqual([{ permission: "list", patterns: ["src"], always: ["src"] }]);
			});

			it("uses current directory when find path is omitted", () => {
				// given
				const input = { pattern: "**/*.ts" };

				// when
				const result = registry.parse("find", input, cwd);

				// then
				expect(result).toEqual([{ permission: "list", patterns: ["."], always: ["."] }]);
			});
		});

		describe("ls", () => {
			it("maps ls to list permission with the provided path", () => {
				// given
				const input = { path: "packages", limit: 20 };

				// when
				const result = registry.parse("ls", input, cwd);

				// then
				expect(result).toEqual([{ permission: "list", patterns: ["packages"], always: ["packages"] }]);
			});

			it("uses current directory when ls path is omitted", () => {
				// given
				const input = { limit: 20 };

				// when
				const result = registry.parse("ls", input, cwd);

				// then
				expect(result).toEqual([{ permission: "list", patterns: ["."], always: ["."] }]);
			});
		});

		describe("registry coverage", () => {
			it("includes a parser for each builtin tool covered by the permission port", () => {
				// given
				const tools = ["bash", "edit", "write", "apply_patch", "multiedit", "read", "grep", "find", "ls"];

				// when
				const results = tools.map((toolName) => registry.parse(toolName, {}, cwd));

				// then
				expect(results).toHaveLength(9);
				expect(results.every((requests) => requests.length > 0)).toBe(true);
			});
		});
	});
});
