import { describe, expect, it } from "vitest";
import { resolveToolNameMatch, toolNameForms } from "../src/utils/tool-name-match.ts";

describe("toolNameForms", () => {
	it("returns a plain name alone", () => {
		expect(toolNameForms("lazy_weather")).toEqual(["lazy_weather"]);
	});

	it("cuts a namespace only at its delimiter, never inside the tool name", () => {
		expect(toolNameForms("mcp__686f__Eval")).toEqual(["mcp__686f__Eval", "Eval"]);
		expect(toolNameForms("MCP__my_server__Tool")).toEqual(["MCP__my_server__Tool", "Tool"]);
		expect(toolNameForms("mcp__srv__lsp_symbols")).toEqual(["mcp__srv__lsp_symbols", "lsp_symbols"]);
		expect(toolNameForms("mcp_github_create_issue")).toEqual(["mcp_github_create_issue", "create_issue"]);
	});
});

describe("resolveToolNameMatch", () => {
	it.each([
		["mcp__686f__Eval", ["eval", "read"], "eval"],
		["Mcp__686f__Eval", ["eval", "read"], "eval"],
		["MCP__686f__lazy_weather", ["lazy_weather"], "lazy_weather"],
		["MCP__srv__tool", ["mcp__srv__Tool", "read"], "mcp__srv__Tool"],
		["mcp__github__create_issue", ["mcp_github_create_issue"], "mcp_github_create_issue"],
		["mcp__my_server__Memory", ["memory", "read"], "memory"],
		["create_issue", ["mcp_github_create_issue", "read"], "mcp_github_create_issue"],
		["Tool", ["mcp__srv__Tool"], "mcp__srv__Tool"],
		["mcp__other__Tool", ["mcp__srv__Tool"], "mcp__srv__Tool"],
	])("resolves %s against %j to %s", (requested, available, expected) => {
		expect(resolveToolNameMatch(requested, available)).toBe(expected);
	});

	it("prefers the exact name over any fold", () => {
		expect(resolveToolNameMatch("foo_bar", ["foo_bar", "foo-bar"])).toBe("foo_bar");
	});

	it("prefers a full-name fold over a namespace-stripped match", () => {
		expect(resolveToolNameMatch("Tool", ["tool", "mcp__srv__Tool"])).toBe("tool");
		expect(resolveToolNameMatch("MCP__srv__read", ["read", "mcp_srv_read"])).toBe("mcp_srv_read");
	});

	it("refuses when two tools share a fold key", () => {
		expect(resolveToolNameMatch("mcp__686f__FooBar", ["foo_bar", "foo-bar"])).toBeUndefined();
	});

	it("refuses when two registered tools share a namespace-stripped name", () => {
		expect(
			resolveToolNameMatch("create_issue", ["mcp_github_create_issue", "mcp_linear_create_issue"]),
		).toBeUndefined();
	});

	it.each([
		["mcp__gh__pull_request_read", ["read", "mcp_github_pull_request_read"], "mcp_github_pull_request_read"],
		["mcp__gh__create_issue", ["issue", "mcp_github_create_issue"], "mcp_github_create_issue"],
		["mcp__my_server__Memory", ["memory", "server_memory"], "memory"],
	])("prefers the specific tool over a trailing word (%s)", (requested, available, expected) => {
		expect(resolveToolNameMatch(requested, available)).toBe(expected);
	});

	it.each([
		["mcp__sandbox__run_bash", ["bash", "read"]],
		["mcp__e2b__exec_bash", ["bash"]],
		["mcp__fs__file_write", ["write"]],
		["mcp__srv__lsp_symbols", ["symbols"]],
		["mcp_a_b_c", ["c"]],
	])("never resolves a part of the tool's own name to a local tool (%s)", (requested, available) => {
		expect(resolveToolNameMatch(requested, available)).toBeUndefined();
	});

	it("refuses a name nothing resembles", () => {
		expect(resolveToolNameMatch("mcp__686f__Deploy", ["read", "eval"])).toBeUndefined();
	});
});

describe("resolveToolNameMatch with a stray word prefix (omo#12065)", () => {
	const tools = ["eval", "write", "todo", "read", "kill_bash", "bash", "task_output"];

	it.each([
		["trophy_eval", "eval"],
		["fringe_write", "write"],
		["board_eval", "eval"],
		["column_todo", "todo"],
		["stray_task_output", "task_output"],
	])("resolves %s to the one tool its '_'-separated suffix names (%s)", (requested, expected) => {
		expect(resolveToolNameMatch(requested, tools)).toBe(expected);
	});

	it.each(["kill_bash", "task_output", "eval"])("leaves a registered name untouched (%s)", (requested) => {
		expect(resolveToolNameMatch(requested, tools)).toBe(requested);
	});

	it("refuses when two registered tools are suffixes of the name", () => {
		expect(resolveToolNameMatch("x_read_file", ["read_file", "file"])).toBeUndefined();
	});

	it("refuses a prefixed name whose suffix names no tool", () => {
		expect(resolveToolNameMatch("foo_bar_baz", tools)).toBeUndefined();
	});
});
