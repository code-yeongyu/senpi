import { describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.js";
import { createBashToolDefinition } from "../../src/core/tools/bash.js";
import { createEditToolDefinition } from "../../src/core/tools/edit.js";
import { createFindToolDefinition } from "../../src/core/tools/find.js";
import { createGrepToolDefinition } from "../../src/core/tools/grep.js";
import { createLsToolDefinition } from "../../src/core/tools/ls.js";
import { createReadToolDefinition } from "../../src/core/tools/read.js";
import { createWriteToolDefinition } from "../../src/core/tools/write.js";

describe("parser contract tests", () => {
	const cwd = "/workspace/project";
	const registry = createBuiltinParserRegistry();
	const bashToolDefinition = createBashToolDefinition(cwd);
	const editToolDefinition = createEditToolDefinition(cwd);
	const findToolDefinition = createFindToolDefinition(cwd);
	const grepToolDefinition = createGrepToolDefinition(cwd);
	const lsToolDefinition = createLsToolDefinition(cwd);
	const readToolDefinition = createReadToolDefinition(cwd);
	const writeToolDefinition = createWriteToolDefinition(cwd);

	describe("bash parser contract", () => {
		it("should have command field in bash schema", () => {
			// given
			const schema = bashToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("command");
			expect(schema.properties.command.type).toBe("string");
		});

		it("should parse bash tool input matching schema", () => {
			// given
			const input = { command: "git status" };

			// when
			const result = registry.parse("bash", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("bash");
			expect(result[0].patterns).toContain("git status");
		});

		it("should handle bash with timeout field", () => {
			// given - timeout is optional per schema
			const input = { command: "sleep 5", timeout: 10 };

			// when
			const result = registry.parse("bash", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("bash");
		});
	});

	describe("edit parser contract", () => {
		it("should have path and edits fields in edit schema", () => {
			// given
			const schema = editToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("path");
			expect(schema.properties).toHaveProperty("edits");
			expect(schema.properties.path.type).toBe("string");
			expect(schema.properties.edits.type).toBe("array");
		});

		it("should parse edit tool input matching schema", () => {
			// given
			const input = {
				path: "src/index.ts",
				edits: [{ oldText: "foo", newText: "bar" }],
			};

			// when
			const result = registry.parse("edit", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("edit");
			expect(result[0].patterns).toContain("src/index.ts");
		});
	});

	describe("write parser contract", () => {
		it("should have path and content fields in write schema", () => {
			// given
			const schema = writeToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("path");
			expect(schema.properties).toHaveProperty("content");
			expect(schema.properties.path.type).toBe("string");
			expect(schema.properties.content.type).toBe("string");
		});

		it("should parse write tool input matching schema", () => {
			// given
			const input = { path: "src/new-file.ts", content: "export const x = 1;" };

			// when
			const result = registry.parse("write", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("edit");
			expect(result[0].patterns).toContain("src/new-file.ts");
		});
	});

	describe("read parser contract", () => {
		it("should have path field in read schema", () => {
			// given
			const schema = readToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("path");
			expect(schema.properties.path.type).toBe("string");
		});

		it("should have optional offset and limit fields", () => {
			// given
			const schema = readToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("offset");
			expect(schema.properties).toHaveProperty("limit");
		});

		it("should parse read tool input matching schema", () => {
			// given
			const input = { path: "README.md" };

			// when
			const result = registry.parse("read", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("read");
			expect(result[0].patterns).toContain("README.md");
		});

		it("should handle read with offset and limit", () => {
			// given
			const input = { path: "large-file.txt", offset: 100, limit: 50 };

			// when
			const result = registry.parse("read", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("read");
			expect(result[0].patterns).toContain("large-file.txt");
		});
	});

	describe("grep parser contract", () => {
		it("should have pattern field in grep schema", () => {
			// given
			const schema = grepToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("pattern");
			expect(schema.properties.pattern.type).toBe("string");
		});

		it("should have optional path field in grep schema", () => {
			// given
			const schema = grepToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("path");
		});

		it("should parse grep tool input with pattern only", () => {
			// given
			const input = { pattern: "function" };

			// when
			const result = registry.parse("grep", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("grep");
			expect(result[0].patterns).toContain("function");
		});

		it("should parse grep tool input with pattern and path", () => {
			// given
			const input = { pattern: "class", path: "src" };

			// when
			const result = registry.parse("grep", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("grep");
			expect(result[0].patterns).toContain("src");
		});
	});

	describe("find parser contract", () => {
		it("should have pattern field in find schema", () => {
			// given
			const schema = findToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("pattern");
			expect(schema.properties.pattern.type).toBe("string");
		});

		it("should have optional path and limit fields", () => {
			// given
			const schema = findToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("path");
			expect(schema.properties).toHaveProperty("limit");
		});

		it("should parse find tool input matching schema", () => {
			// given
			const input = { pattern: "**/*.ts", path: "src" };

			// when
			const result = registry.parse("find", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("list");
			expect(result[0].patterns).toContain("src");
		});
	});

	describe("ls parser contract", () => {
		it("should have optional path field in ls schema", () => {
			// given
			const schema = lsToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("path");
		});

		it("should have optional limit field in ls schema", () => {
			// given
			const schema = lsToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("limit");
			expect(schema.properties.limit.type).toBe("number");
		});

		it("should parse ls tool input with path", () => {
			// given
			const input = { path: "packages", limit: 20 };

			// when
			const result = registry.parse("ls", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("list");
			expect(result[0].patterns).toContain("packages");
		});

		it("should parse ls tool input without path (defaults to cwd)", () => {
			// given
			const input = {};

			// when
			const result = registry.parse("ls", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("list");
			expect(result[0].patterns).toContain(".");
		});
	});

	describe("apply_patch parser contract", () => {
		it("should parse apply_patch with file_path field", () => {
			// given - apply_patch uses file_path (opencode-style alias)
			const input = { file_path: "src/patched.ts" };

			// when
			const result = registry.parse("apply_patch", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("edit");
			expect(result[0].patterns).toContain("src/patched.ts");
		});

		it("should fallback to wildcard when file_path is missing", () => {
			// given
			const input = {};

			// when
			const result = registry.parse("apply_patch", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("edit");
			expect(result[0].patterns).toContain("*");
		});
	});

	describe("multiedit parser contract", () => {
		it("should parse multiedit with file_path field", () => {
			// given - multiedit uses file_path (opencode-style alias)
			const input = { file_path: "src/multi.ts" };

			// when
			const result = registry.parse("multiedit", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("edit");
			expect(result[0].patterns).toContain("src/multi.ts");
		});

		it("should fallback to wildcard when file_path is missing", () => {
			// given
			const input = {};

			// when
			const result = registry.parse("multiedit", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("edit");
			expect(result[0].patterns).toContain("*");
		});
	});

	describe("unknown tool fallback", () => {
		it("should fallback to tool-level permission for unknown tools", () => {
			// given - a tool that has no parser registered
			const input = { someField: "someValue" };

			// when
			const result = registry.parse("unknown_tool", input, cwd);

			// then
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("unknown_tool");
			expect(result[0].patterns).toEqual(["*"]);
			expect(result[0].always).toEqual(["*"]);
		});

		it("should fallback when new upstream tool has no parser", () => {
			// given - simulating a new tool added upstream
			const newToolInput = { command: "do something" };

			// when
			const result = registry.parse("new_upstream_tool", newToolInput, cwd);

			// then - should not throw, should return fallback
			expect(result).toHaveLength(1);
			expect(result[0].permission).toBe("new_upstream_tool");
			expect(result[0].patterns).toEqual(["*"]);
		});
	});

	describe("schema drift detection", () => {
		it("should detect if bash schema changes command field name", () => {
			// given - verify the schema we expect still exists
			const schema = bashToolDefinition.parameters;

			// then - if this fails, upstream changed the field name
			expect(schema.properties).toHaveProperty("command");
			expect(schema.properties.command.type).toBe("string");
		});

		it("should detect if edit schema changes path field name", () => {
			// given
			const schema = editToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("path");
			expect(schema.properties.path.type).toBe("string");
		});

		it("should detect if read schema changes path field name", () => {
			// given
			const schema = readToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("path");
			expect(schema.properties.path.type).toBe("string");
		});

		it("should detect if grep schema changes pattern field name", () => {
			// given
			const schema = grepToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("pattern");
			expect(schema.properties.pattern.type).toBe("string");
		});

		it("should detect if find schema changes pattern field name", () => {
			// given
			const schema = findToolDefinition.parameters;

			// then
			expect(schema.properties).toHaveProperty("pattern");
			expect(schema.properties.pattern.type).toBe("string");
		});
	});
});
