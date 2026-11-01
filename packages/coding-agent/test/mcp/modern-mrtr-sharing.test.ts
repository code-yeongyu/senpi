import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRequestOrigin, mcpRequestOptions } from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { MrtrScript, inputResult, startMrtrServer } from "./fixtures/mrtr-2026-server.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { readMcpResourceAsText } from "../../src/core/extensions/builtin/mcp/resources.ts";
import { capturingPi, registeredTool, testContext, textContent } from "./fixtures/register-call.ts";
import { makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";

import { pooledMrtr } from "./fixtures/mrtr-pool.ts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});
const pooled = (results: unknown[], enabled = true) => pooledMrtr(results, cleanup, enabled);

describe("MRTR request ownership", () => {
	it("keeps modern human capability request-local when legacy elicitation is disabled", async () => {
		const { a, b, script } = await pooled([inputResult(), undefined, inputResult()], false);
		const ui = mrtrTui();
		const origin = createMcpRequestOrigin({
			binding: {},
			connection: a,
			signal: a.requestLifetimeSignal,
			presentation: ui.presentation,
			serverLabel: "fixture",
			isCurrent: () => a.state === "connected",
			resolveAuthority: async () => null,
		});
		expect((await a.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(origin))).content).toEqual([
			{ type: "text", text: "final tool" },
		]);
		await expect(b.client.callTool({ name: "fixture" })).rejects.toMatchObject({
			code: "MCP_MRTR_PROCESSING_UNAVAILABLE",
		});
		const capabilities = ["_meta", "io.modelcontextprotocol/clientCapabilities"];
		expect(script.requests[0]?.params).toHaveProperty(capabilities, { elicitation: {} });
		expect(script.requests[2]?.params).toHaveProperty(capabilities, {});
		expect(script.requests).toHaveLength(3);
	});
	it.each(["tool", "resource", "prompt", "tool-disconnect"])(
		"the real service propagates the originating TUI through %s registration",
		async (kind) => {
			const root = makeRoot("mrtr-binding", cleanup);
			const script = new MrtrScript([inputResult()]);
			if (kind === "tool-disconnect") script.disconnectAfterRound = 1;
			const server = await startMrtrServer(script);
			cleanup.push(server.close);
			setConfig(root, { fixture: { type: "http", url: server.url, auth: false, exposure: "direct" } });
			const service = new McpService();
			cleanup.push(() => service.dispose("quit"));
			const pi = capturingPi();
			const ui = mrtrTui();
			const registered = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					unsubscribe();
					reject(new Error("MCP registration deadline"));
				}, 10000);
				const unsubscribe = service.onMcpRegistrationChanged(() => {
					if (
						!service
							.getMcpPromptServers(pi)
							.some((entry) => entry.prompts.some((prompt) => prompt.name === "fixture"))
					)
						return;
					clearTimeout(timeout);
					unsubscribe();
					resolve();
				});
			});
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true, ui: ui.ui },
				pi,
				{ agentDir: root.agentDir },
			);
			await registered;
			if (kind.startsWith("tool")) {
				const name = [...pi.toolDefinitions.keys()].find(
					(key) => key.includes("fixture") && key !== "mcp_list_resources" && key !== "mcp_read_resource",
				);
				if (!name) throw new Error("MCP tool did not register");
				const result = registeredTool(pi, name).execute(
					"call",
					{},
					undefined,
					undefined,
					testContext() as ExtensionToolContext,
				);
				if (kind === "tool-disconnect")
					await expect(result).rejects.toMatchObject({ code: "MCP_MRTR_TRANSPORT_FAILED", retriable: false });
				else expect(textContent(await result)).toContain("final tool");
			} else if (kind === "resource") {
				const resource = service.getMcpResourceServers(pi)[0];
				if (!resource) throw new Error("Resource did not register");
				expect(await readMcpResourceAsText(resource, "test://fixture")).toContain("final resource");
			} else {
				const prompt = service.getMcpPromptServers(pi)[0];
				if (!prompt) throw new Error("Prompt did not register");
				const result = await prompt.connection.client.getPrompt(
					{ name: "fixture" },
					mcpRequestOptions(prompt.requestOrigin?.()),
				);
				expect(result.messages[0]?.content).toEqual({ type: "text", text: "final prompt" });
			}
			expect(script.requests).toHaveLength(2);
		},
	);
	it("observed invalidation while consent is pending fails without dispatching the retry", async () => {
		const { a, script } = await pooled([inputResult()]);
		const shown = Promise.withResolvers<void>();
		const dismissed = Promise.withResolvers<void>();
		const ui = mrtrTui(async (_title, _choices, opts) => {
			shown.resolve();
			return await new Promise<undefined>((resolve) => {
				opts?.signal?.addEventListener(
					"abort",
					() => {
						dismissed.resolve();
						resolve(undefined);
					},
					{ once: true },
				);
			});
		});
		const origin = createMcpRequestOrigin({
			binding: {},
			connection: a,
			signal: a.requestLifetimeSignal,
			presentation: ui.presentation,
			serverLabel: "fixture",
			isCurrent: () => a.state === "connected",
			resolveAuthority: async () => null,
		});
		const pending = a.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(origin));
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_CONTEXT_CHANGED" });
		await shown.promise;
		await a.bumpGeneration();
		await rejected;
		await dismissed.promise;
		expect(script.requests).toHaveLength(1);
	});
	it("lease release dismisses its consent but leaves the other owner connected", async () => {
		const { a, b, script } = await pooled([inputResult()]);
		const shown = Promise.withResolvers<void>();
		const ui = mrtrTui(async (_title, _choices, opts) => {
			shown.resolve();
			return await new Promise<undefined>((resolve) =>
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
			);
		});
		const origin = createMcpRequestOrigin({
			binding: {},
			connection: a,
			signal: a.requestLifetimeSignal,
			presentation: ui.presentation,
			serverLabel: "fixture",
			isCurrent: () => a.state === "connected",
			resolveAuthority: async () => null,
		});
		const pending = a.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(origin));
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_CONTEXT_CHANGED" });
		await shown.promise;
		await a.dispose();
		await rejected;
		expect(b.state).toBe("connected");
		expect((await b.client.callTool({ name: "fixture" })).content).toEqual([{ type: "text", text: "final tool" }]);
		expect(script.requests).toHaveLength(2);
	});
	it("headless and RPC self declarations never gain consent authority", async () => {
		const { a, script } = await pooled([inputResult()]);
		const origin = createMcpRequestOrigin({
			binding: {},
			connection: a,
			signal: a.requestLifetimeSignal,
			serverLabel: "fixture",
			isCurrent: () => true,
			resolveAuthority: async () => null,
		});
		await expect(
			a.client.callTool(
				{
					name: "fixture",
					_meta: {
						"io.modelcontextprotocol/clientCapabilities": {
							elicitation: {},
							ephemeral_dialogs: true,
							interactive_user: true,
						},
					},
				},
				undefined,
				mcpRequestOptions(origin),
			),
		).rejects.toMatchObject({ code: "MCP_MRTR_PROCESSING_UNAVAILABLE" });
		expect(script.requests).toHaveLength(1);
		expect(script.requests[0]?.params).toHaveProperty(["_meta", "io.modelcontextprotocol/clientCapabilities"], {});
	});
	it("policy or credential fence changes after consent prohibit continuation", async () => {
		const { a, script } = await pooled([inputResult()]);
		let revision = 0;
		const ui = mrtrTui(async (_title, choices) => {
			if (choices.includes("Submit")) {
				revision++;
				return "Submit";
			}
			return choices[0];
		});
		const resolve = vi.fn(async () => revision);
		const origin = createMcpRequestOrigin({
			binding: {},
			connection: a,
			signal: a.requestLifetimeSignal,
			presentation: ui.presentation,
			serverLabel: "fixture",
			isCurrent: () => true,
			resolveAuthority: resolve,
		});
		await expect(a.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(origin))).rejects.toMatchObject({
			code: "MCP_MRTR_CONTEXT_CHANGED",
		});
		expect(resolve).toHaveBeenCalled();
		expect(script.requests).toHaveLength(1);
	});
});
