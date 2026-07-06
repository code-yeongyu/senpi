import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	buildMcpToolNames,
	collectAllPages,
	convertJsonSchemaToTypeBox,
	type McpListPage,
	type McpToolNameEntry,
	mapMcpToolResult,
	prepareOutputSchemaRetry,
} from "../../src/core/extensions/builtin/mcp/expose/schema-compat.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "schema");

describe("mcp schema compatibility", () => {
	it("converts nasty JSON Schema to TypeBox-compatible JSON without losing supported keywords", () => {
		const source = readFixture("nasty-input.schema.json");
		const golden = readFixture("nasty-input.typebox.golden.json");

		const result = convertJsonSchemaToTypeBox(source);

		expect(result.warnings).toEqual([]);
		expect(JSON.parse(JSON.stringify(result.schema))).toEqual(golden);
		expect(JSON.stringify(result.schema)).not.toContain('"$schema"');
		expect(Object.getOwnPropertyDescriptor(result.schema, "additionalProperties")).toBeUndefined();
	});

	it("falls back to a permissive object and warning for unresolvable refs", () => {
		const result = convertJsonSchemaToTypeBox({
			type: "object",
			properties: { broken: { $ref: "#/$defs/missing" } },
			required: ["broken"],
		});

		expect(JSON.parse(JSON.stringify(result.schema))).toEqual({ type: "object", properties: {} });
		expect(result.warnings).toEqual([
			"MCP schema contains unresolvable $ref '#/$defs/missing'; using permissive object schema.",
		]);
	});

	it("prepares outputSchema retry data by stripping top-level incompatible declarations", () => {
		const result = prepareOutputSchemaRetry({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			properties: { ok: { type: "boolean" } },
		});

		expect(result.schema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
		expect(result.warnings).toEqual([
			"Stripped top-level $schema from MCP outputSchema retry.",
			"Stripped top-level additionalProperties from MCP outputSchema retry.",
		]);
	});
});

describe("mcp content result mapping", () => {
	it("maps all supported MCP content blocks and structuredContent without dropping data", () => {
		const result = mapMcpToolResult({
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "aW1n", mimeType: "image/png" },
				{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
				{ type: "resource", resource: { uri: "file:///tmp/a.txt", text: "A" } },
				{ type: "resource_link", uri: "https://example.test", name: "Example" },
			],
			structuredContent: { answer: 42 },
		});

		expect(result).toEqual({
			ok: true,
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "aW1n", mimeType: "image/png" },
				{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
				{ type: "resource", resource: { uri: "file:///tmp/a.txt", text: "A" } },
				{ type: "resource_link", uri: "https://example.test", name: "Example" },
				{ type: "text", text: '{"answer":42}' },
			],
		});
	});

	it("maps empty results to visible text and isError to typed bridge failure", () => {
		expect(mapMcpToolResult({ content: [] })).toEqual({
			ok: true,
			content: [{ type: "text", text: "(empty result)" }],
		});
		expect(mapMcpToolResult({ isError: true, content: [{ type: "text", text: "bad" }] })).toEqual({
			ok: false,
			error: {
				message: "bad",
				content: [{ type: "text", text: "bad" }],
			},
		});
	});
});

describe("mcp tool naming", () => {
	it("normalizes names, middle-ellipsizes to 64 chars, and makes collisions deterministic", () => {
		const warn = vi.fn();
		const entries: McpToolNameEntry[] = [
			{ serverName: "server/name", toolName: "first tool" },
			{
				serverName: "very-long-server-name-with-many-segments-and-symbols",
				toolName: "very-long-tool-name-with-many-segments-and-symbols",
			},
			{ serverName: "alpha-beta", toolName: "same" },
			{ serverName: "alpha_beta", toolName: "same" },
		];

		const names = buildMcpToolNames(entries, warn);

		expect(names[0]).toBe("mcp_server_name_first_tool");
		expect(names[1]).toHaveLength(64);
		expect(names[1]).toBe("mcp_very-long-server-name-with-...with-many-segments-and-symbols");
		expect(names[2]).toMatch(/^mcp_alpha-beta_same_[0-9a-f]{4}$/);
		expect(names[3]).toMatch(/^mcp_alpha_beta_same_[0-9a-f]{4}$/);
		expect(new Set(names).size).toBe(names.length);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("MCP tool name collision after normalization"));
	});
});

describe("mcp pagination", () => {
	it("collects all pages and stops on duplicate cursors", async () => {
		const calls: (string | undefined)[] = [];
		const pages: Record<string, McpListPage<number>> = {
			start: { items: [1], nextCursor: "a" },
			a: { items: [2], nextCursor: "a" },
		};

		const result = await collectAllPages<number>((cursor: string | undefined) => {
			calls.push(cursor);
			return Promise.resolve(pages[cursor ?? "start"]);
		});

		expect(result.items).toEqual([1, 2]);
		expect(calls).toEqual([undefined, "a"]);
		expect(result.warnings).toEqual(["Stopped MCP pagination after duplicate cursor 'a'."]);
	});

	it("stops at a 1000-page cap", async () => {
		const result = await collectAllPages<string>((cursor: string | undefined) =>
			Promise.resolve({ items: [cursor ?? "start"], nextCursor: String(Number(cursor ?? "0") + 1) }),
		);

		expect(result.items).toHaveLength(1000);
		expect(result.warnings).toEqual(["Stopped MCP pagination after 1000 pages."]);
	});
});

function readFixture(name: string): unknown {
	const parsed: unknown = JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
	return parsed;
}
