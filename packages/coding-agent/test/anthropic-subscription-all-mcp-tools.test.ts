import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildCustomToolServers } from "../src/core/extensions/builtin/anthropic-subscription/custom-tools.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../src/core/extensions/builtin/anthropic-subscription/options.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SdkBoundary,
} from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	BUILTIN_SDK_TOOLS,
	CUSTOM_TOOLS_MCP_PREFIX,
	HOST_CAPTURED_SDK_TOOL_MATCHER,
	HOST_TOOL_POLICY_FINGERPRINT,
	mapSdkToolNameToPi,
	resolveSdkTools,
	translatesBuiltinArguments,
} from "../src/core/extensions/builtin/anthropic-subscription/tools.ts";

const model: Model<Api> = {
	id: "claude-opus-5-5",
	name: "Claude",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function tool(name: string, parameters: Tool["parameters"] = Type.Object({})): Tool {
	return { name, description: `${name} tool`, parameters };
}

function context(...tools: Tool[]): Context {
	return { messages: [], tools };
}

const STOCK = [tool("read"), tool("bash"), tool("edit"), tool("write"), tool("grep"), tool("find"), tool("eval")];

afterEach(() => resetSdkBoundary());

describe("anthropic-subscription serves every senpi tool through the custom-tools MCP server (senpi#5159)", () => {
	it("offers Claude Code no built-in tool at all", () => {
		expect([...BUILTIN_SDK_TOOLS]).toEqual([]);
		const resolved = resolveSdkTools(context(...STOCK));
		expect(resolved.customTools.map(({ name }) => name)).toEqual(STOCK.map(({ name }) => name));
		expect(resolved.customToolNameToPi.get(`${CUSTOM_TOOLS_MCP_PREFIX}bash`)).toBe("bash");
		expect(resolveSdkTools({ messages: [] }).customTools).toEqual([]);
	});

	it("keeps a custom bash schema instead of shadowing it with the built-in Bash (senpi#4059)", () => {
		const broker = tool(
			"bash",
			Type.Object({ program: Type.String(), args: Type.Array(Type.String()) }, { additionalProperties: false }),
		);
		const resolved = resolveSdkTools(context(broker));
		expect(resolved.customTools).toEqual([broker]);
		expect(resolved.toolAliases).toEqual({
			Bash: `${CUSTOM_TOOLS_MCP_PREFIX}bash`,
			bash: `${CUSTOM_TOOLS_MCP_PREFIX}bash`,
		});
	});

	it("derives the built-in-name aliases from the active tools only", () => {
		const resolved = resolveSdkTools(context(tool("read"), tool("edit"), tool("find"), tool("eval")));
		expect(resolved.toolAliases).toEqual({
			Read: `${CUSTOM_TOOLS_MCP_PREFIX}read`,
			read: `${CUSTOM_TOOLS_MCP_PREFIX}read`,
			Edit: `${CUSTOM_TOOLS_MCP_PREFIX}edit`,
			edit: `${CUSTOM_TOOLS_MCP_PREFIX}edit`,
			MultiEdit: `${CUSTOM_TOOLS_MCP_PREFIX}edit`,
			multiedit: `${CUSTOM_TOOLS_MCP_PREFIX}edit`,
			Glob: `${CUSTOM_TOOLS_MCP_PREFIX}find`,
			glob: `${CUSTOM_TOOLS_MCP_PREFIX}find`,
		});
		expect(resolveSdkTools(context(tool("eval"))).toolAliases).toEqual({});
	});

	it("prefers an active tool literally named glob over the find fallback for the Glob alias", () => {
		const resolved = resolveSdkTools(context(tool("glob"), tool("find")));
		expect(resolved.toolAliases.Glob).toBe(`${CUSTOM_TOOLS_MCP_PREFIX}glob`);
		expect(mapSdkToolNameToPi("Glob", resolved.customToolNameToPi)).toBe("glob");
		expect(mapSdkToolNameToPi("Glob", resolveSdkTools(context(tool("find"))).customToolNameToPi)).toBe("find");
		// Legacy transcripts recorded under the built-in names still resolve without a context.
		expect(mapSdkToolNameToPi("Glob")).toBe("find");
		expect(mapSdkToolNameToPi("MultiEdit", resolveSdkTools(context(tool("edit"))).customToolNameToPi)).toBe("edit");
	});

	it("translates built-in argument shapes only for calls the model emitted under a built-in name", () => {
		for (const name of ["Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob"]) {
			expect(translatesBuiltinArguments(name)).toBe(true);
		}
		for (const name of ["mcp__custom-tools__bash", "mcp__custom-tools__edit", "bash", "edit", "eval", "WebFetch"]) {
			expect(translatesBuiltinArguments(name)).toBe(false);
		}
	});

	it("builds query options with tools: [] and the alias map, whatever the context offers", () => {
		const resolved = resolveSdkTools(context(...STOCK));
		const options = buildAnthropicSubscriptionQueryOptions({
			model,
			context: context(...STOCK),
			cwd: process.cwd(),
			providerSettings: {},
			toolAliases: resolved.toolAliases,
		});
		expect(options.tools).toEqual([]);
		expect(options.toolAliases).toEqual(resolved.toolAliases);
		expect(options.permissionMode).toBe("dontAsk");
		const matcher = new RegExp(`^(?:${options.hooks?.PreToolUse?.[0]?.matcher ?? "(?!)"})$`);
		expect(HOST_CAPTURED_SDK_TOOL_MATCHER).toBe("mcp__custom-tools__.*");
		for (const name of Object.values(resolved.toolAliases)) expect(matcher.test(name)).toBe(true);
		expect(matcher.test("mcp__custom-tools__eval")).toBe(true);
	});

	it("omits the alias map from a tool-less or alias-less query", () => {
		const toolLess = buildAnthropicSubscriptionQueryOptions({
			model,
			context: context(...STOCK),
			streamOptions: { toolChoice: "none" },
			cwd: process.cwd(),
			providerSettings: {},
			toolAliases: resolveSdkTools(context(...STOCK)).toolAliases,
		});
		expect(toolLess.tools).toEqual([]);
		expect(toolLess).not.toHaveProperty("toolAliases");
		const aliasLess = buildAnthropicSubscriptionQueryOptions({
			model,
			context: context(tool("eval")),
			cwd: process.cwd(),
			providerSettings: {},
			toolAliases: {},
		});
		expect(aliasLess).not.toHaveProperty("toolAliases");
	});

	it("registers the custom-tools server with alwaysLoad so no senpi tool is deferred behind tool search", async () => {
		const captured: Parameters<SdkBoundary["createSdkMcpServer"]>[0][] = [];
		overrideSdkBoundary({
			createSdkMcpServer: (options) => {
				captured.push(options);
				return { type: "sdk", name: options.name, instance: {} } as unknown as ReturnType<
					SdkBoundary["createSdkMcpServer"]
				>;
			},
		});
		await buildCustomToolServers([tool("read"), tool("bash")]);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.alwaysLoad).toBe(true);
		expect(captured[0]?.tools?.map((definition) => definition.name)).toEqual(["read", "bash"]);
	});

	it("bumps the host tool policy so resident sessions reattach with toolset_changed", () => {
		expect(HOST_TOOL_POLICY_FINGERPRINT).toBe("host-tool-denial-v5");
	});
});
