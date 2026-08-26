import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	buildCustomToolServers,
	denyCustomToolExecution,
} from "../src/core/extensions/builtin/claude-sdk-oauth/custom-tools.ts";
import { createToolWatch, registerToolWatch } from "../src/core/extensions/builtin/claude-sdk-oauth/tool-watch.ts";
import {
	BUILTIN_SDK_TOOLS,
	canUseTool,
	mapPiToolNameToSdk,
	mapSdkToolNameToPi,
	mapToolArgs,
	resolveSdkTools,
	TOOL_EXECUTION_DENIED_MESSAGE,
} from "../src/core/extensions/builtin/claude-sdk-oauth/tools.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

function contextWithTools(...tools: Tool[]): Context {
	return { messages: [], tools };
}

describe("Claude SDK OAuth tool integration", () => {
	it("derives the SDK allowlist and custom MCP mappings from active senpi tools", () => {
		const resolved = resolveSdkTools(contextWithTools(tool("read"), tool("bash"), tool("find"), tool("repoSearch")));

		expect(resolved.sdkTools).toEqual(["Read", "Bash", "Glob"]);
		expect(resolved.customTools.map(({ name }) => name)).toEqual(["repoSearch"]);
		expect(resolved.customToolNameToSdk.get("repoSearch")).toBe("mcp__custom-tools__repoSearch");
		expect(resolved.customToolNameToPi.get("mcp__custom-tools__repoSearch")).toBe("repoSearch");
		expect(mapPiToolNameToSdk("repoSearch", resolved.customToolNameToSdk)).toBe("mcp__custom-tools__repoSearch");
		expect(mapSdkToolNameToPi("mcp__custom-tools__repoSearch", resolved.customToolNameToPi)).toBe("repoSearch");
		expect(resolveSdkTools({ messages: [] }).sdkTools).toEqual(BUILTIN_SDK_TOOLS);
	});

	it("builds one in-process custom-tools MCP server for active custom tools", async () => {
		const servers = await buildCustomToolServers([tool("repoSearch")]);
		expect(Object.keys(servers ?? {})).toEqual(["custom-tools"]);
	});

	it("always denies Claude Code-side tool execution", async () => {
		const result = await canUseTool(
			"Read",
			{},
			{
				signal: new AbortController().signal,
				toolUseID: "sdk-read",
				requestId: "sdk-request",
			},
		);
		expect(result).toEqual({ behavior: "deny", message: TOOL_EXECUTION_DENIED_MESSAGE });
		expect(await denyCustomToolExecution()).toEqual({
			content: [{ type: "text", text: TOOL_EXECUTION_DENIED_MESSAGE }],
			isError: true,
		});
	});

	it("executes an SDK-proposed Read through senpi's tool contract", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "claude-sdk-oauth-tools-"));
		try {
			await writeFile(join(cwd, "example.txt"), "executed by senpi\n", "utf8");
			const args = mapToolArgs("Read", { file_path: "example.txt" });
			if (typeof args.path !== "string") throw new Error("Read mapping did not supply a path");
			const result = await createReadToolDefinition(cwd).execute(
				"read-1",
				{ path: args.path },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(result.content).toEqual([{ type: "text", text: "executed by senpi\n" }]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it.each([
		["Read", { file_path: "src/main.ts", offset: 4, limit: 12 }, { path: "src/main.ts", offset: 4, limit: 12 }],
		["Write", { file_path: "src/main.ts", content: "export {};" }, { path: "src/main.ts", content: "export {};" }],
		[
			"Edit",
			{ file_path: "src/main.ts", old_string: "before", new_string: "after", replace_all: true },
			{ path: "src/main.ts", edits: [{ oldText: "before", newText: "after" }] },
		],
		["Bash", { command: "npm test", timeout: 30_000 }, { command: "npm test", timeout: 30 }],
		[
			"Grep",
			{ pattern: "needle", path: "src", glob: "*.ts", "-i": true, context: 2, head_limit: 5 },
			{ pattern: "needle", path: "src", glob: "*.ts", ignoreCase: true, context: 2, limit: 5 },
		],
		["Glob", { pattern: "**/*.ts", path: "src" }, { pattern: "**/*.ts", path: "src" }],
	] as const)("translates %s arguments into senpi's tool contract", (name, input, expected) => {
		expect(mapToolArgs(name, input)).toEqual(expected);
	});

	it("tracks tool_execution_end events, reconciles, and recovers completed senpi tool results", () => {
		const watch = createToolWatch();
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const appended: Array<{ customType: string; data: unknown }> = [];
		const extension = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void): void {
				handlers.set(event, handler);
			},
			appendEntry(customType: string, data?: unknown): void {
				appended.push({ customType, data });
			},
		} as unknown as Pick<ExtensionAPI, "on" | "appendEntry">;
		const sessionContext = {
			model: { provider: "claude-sdk-oauth" },
			sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
		} as unknown as ExtensionContext;
		registerToolWatch(extension, watch);
		expect([...handlers.keys()]).toEqual(["session_start", "session_tree", "session_shutdown", "tool_execution_end"]);
		handlers.get("tool_execution_end")?.(
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "file contents" }] },
				isError: false,
			},
			sessionContext,
		);
		const sessionKey = watch.sessionKey("session-1");
		expect(watch.getCompletedToolCall(sessionKey, "call-1")).toMatchObject({ content: "file contents" });
		expect(appended).toHaveLength(1);
		watch.hydrate(sessionKey, [
			{
				type: "custom",
				id: "tool-watch-entry",
				parentId: null,
				timestamp: "2026-07-27T00:00:00.000Z",
				customType: "claude-sdk-oauth-tool-watch",
				data: appended[0]?.data,
			},
		]);
		expect(watch.getCompletedToolCall(sessionKey, "call-1")).toMatchObject({ content: "file contents" });

		const note = watch.buildPromptNote(sessionKey, {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
					api: "claude-sdk-oauth",
					provider: "claude-sdk-oauth",
					model: "claude-test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			],
		});
		expect(note).toContain("TOOL RESULT (recovered Read, id=call-1, status=ok):");
		expect(note).toContain("file contents");

		watch.reconcileWithContext(sessionKey, {
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-2",
					toolName: "bash",
					content: [{ type: "text", text: "command output" }],
					isError: false,
					timestamp: 3,
				},
			],
		});
		expect(watch.getCompletedToolCall(sessionKey, "call-2")).toMatchObject({
			toolName: "bash",
			content: "command output",
		});
	});
});
