import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { createHarness, getAssistantTexts } from "../harness.ts";
import { reservationStep } from "../rpc-worker-reservation-support.ts";

// Quitting the TUI mid-turn disposed the runtime while its run was still active: `session_shutdown` tore down
// extension resources under a running tool, the tool failed, and the dying process sent the failure to the
// model in one more provider request (and an active goal kept queueing continuations). A quit must end the run
// before extensions shut down, the way a session replacement already does.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("quitting while a tool runs ends the run before shutdown and sends no further provider request", async () => {
	const toolStarted = Promise.withResolvers<void>();
	const resourceGone = Promise.withResolvers<never>();
	// Another extension's shutdown work (a sync flush, a socket close) keeps the process alive a while.
	const shutdownWork = Promise.withResolvers<void>();
	const slowTool: AgentTool = {
		name: "slow",
		label: "Slow",
		description: "Waits on an extension-owned resource",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			toolStarted.resolve();
			const aborted = new Promise<never>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			return await Promise.race([resourceGone.promise, aborted]);
		},
	};
	const h = await createHarness({
		tools: [slowTool],
		extensionFactories: [
			(pi) => {
				pi.on("session_shutdown", () => {
					resourceGone.reject(new Error("resource disposed"));
				});
			},
			(pi) => {
				pi.on("session_shutdown", async () => {
					await shutdownWork.promise;
				});
			},
		],
	});
	cleanups.push(h.cleanup);
	let providerCalls = 0;
	const requestAfterQuit = Promise.withResolvers<"request after quit">();
	const stream = h.session.agent.streamFunction;
	h.session.agent.streamFunction = (...args) => {
		providerCalls++;
		if (providerCalls > 1) requestAfterQuit.resolve("request after quit");
		return stream(...args);
	};
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("answered after quit"),
	]);
	const services: AgentSessionServices = {
		cwd: h.tempDir,
		agentDir: h.tempDir,
		authStorage: h.authStorage,
		modelRegistry: h.modelRegistry,
		modelRuntime: h.session.modelRuntime,
		settingsManager: h.settingsManager,
		resourceLoader: h.session.resourceLoader,
		diagnostics: [],
	};
	const factory: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("no replacement in this test");
	};
	const runtime = new AgentSessionRuntime(h.session, services, factory);

	const turn = h.session.prompt("start the slow work").catch(() => {});
	await toolStarted.promise;
	const disposed = runtime.dispose();
	const outcome = await reservationStep(
		"quit-turn-outcome",
		Promise.race([turn.then(() => "settled" as const), requestAfterQuit.promise]),
	);
	shutdownWork.resolve();
	await disposed;

	expect(outcome).toBe("settled");
	expect(providerCalls).toBe(1);
	expect(getAssistantTexts(h)).not.toContain("answered after quit");
});
