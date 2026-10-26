import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRequestOrigin, mcpRequestOptions } from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { MrtrScript, inputResult, startMrtrServer } from "./fixtures/mrtr-2026-server.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { capturingPi, registeredTool, testContext, textContent } from "./fixtures/register-call.ts";
import { makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";

import { pooledMrtr } from "./fixtures/mrtr-pool.ts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});
const pooled = (results: unknown[], enabled = true) => pooledMrtr(results, cleanup, enabled);

describe("MRTR concurrent ownership", () => {
	it("overlapping pooled requests route reversed inputs to their original sessions", async () => {
		const { a, b, script } = await pooled([inputResult("B"), inputResult("A")]);
		const firstReceived = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let initial = 0;
		script.onRequest = async (request) => {
			if (request.method === "tools/call" && request.params?.requestState === undefined && initial++ === 0) {
				firstReceived.resolve();
				await releaseFirst.promise;
			}
		};
		let gated = false;
		const selectB = vi.fn(async (_title: string, choices: string[]) => {
			if (choices.includes("Continue") && !gated) {
				gated = true;
				const aInputSent = script.next("inputResultSent");
				releaseFirst.resolve();
				await aInputSent;
			}
			return choices.includes("Submit") ? "Submit" : choices[0];
		});
		const uiA = mrtrTui(undefined, async () => "answer-A");
		const uiB = mrtrTui(selectB, async () => "answer-B");
		const origin = (connection: typeof a, presentation: typeof uiA.presentation) =>
			createMcpRequestOrigin({
				binding: {},
				connection,
				signal: connection.requestLifetimeSignal,
				presentation,
				serverLabel: "fixture",
				isCurrent: () => connection.state === "connected",
				resolveAuthority: async () => null,
			});
		const ownerA = origin(a, uiA.presentation);
		const ownerB = origin(b, uiB.presentation);
		const pendingA = a.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(ownerA));
		await firstReceived.promise;
		const pendingB = b.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(ownerB));
		await Promise.all([pendingA, pendingB]);
		expect(script.requests).toHaveLength(4);
		expect(script.requests[0]?.id).not.toBe(script.requests[1]?.id);
		expect(script.requests.find((request) => request.params?.requestState === "A")?.params).toHaveProperty(
			["inputResponses", "question", "content", "value"],
			"answer-A",
		);
		expect(script.requests.find((request) => request.params?.requestState === "B")?.params).toHaveProperty(
			["inputResponses", "question", "content", "value"],
			"answer-B",
		);
	});
	it("classic shared service never chooses its latest binding for MRTR", async () => {
		const root = makeRoot("mrtr-classic-owners", cleanup);
		const script = new MrtrScript([inputResult()]);
		const server = await startMrtrServer(script);
		cleanup.push(server.close);
		setConfig(root, { fixture: { type: "http", url: server.url, auth: false, exposure: "direct" } });
		const service = new McpService({ servesManySessions: true });
		cleanup.push(() => service.dispose("quit"));
		const piA = capturingPi();
		const piB = capturingPi();
		const uiA = mrtrTui(undefined, async () => "classic-A");
		const selectB = vi.fn(async (_title: string, choices: string[]) =>
			choices.includes("Submit") ? "Submit" : choices[0],
		);
		const uiB = mrtrTui(selectB, async () => "classic-B");
		for (const [pi, ui] of [
			[piA, uiA],
			[piB, uiB],
		] as const) {
			await service.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true, ui: ui.ui },
				pi,
				{ agentDir: root.agentDir },
			);
			expect(await service.whenAttachSettled(10000)).toBe("settled");
		}
		const name = [...piA.toolDefinitions.keys()].find(
			(key) => key.includes("fixture") && key !== "mcp_list_resources" && key !== "mcp_read_resource",
		);
		if (!name) throw new Error("Classic tool registration missing");
		const result = await registeredTool(piA, name).execute(
			"call",
			{},
			undefined,
			undefined,
			testContext() as ExtensionToolContext,
		);
		expect(textContent(result)).toContain("final tool");
		expect(selectB).not.toHaveBeenCalled();
		expect(script.requests).toHaveLength(2);
		expect(script.requests[1]?.params).toHaveProperty(
			["inputResponses", "question", "content", "value"],
			"classic-A",
		);
	});
});
