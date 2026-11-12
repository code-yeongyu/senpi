import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

/**
 * Senpi #470/#471: a reentrant Code Mode bridge call (a tool that invokes
 * `AgentSession.executeTool` from inside its own execution) must not deadlock
 * on `_agentEventQueue` while that queue is held by the parent tool's stream.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function createBridgeHarness(extensionFactory: ExtensionFactory): Promise<Harness> {
	const tempDir = mkdtempSync(join(tmpdir(), "senpi-470-bridge-"));
	const loader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: join(tempDir, "agent"),
		settingsManager: SettingsManager.inMemory({}),
		extensionFactories: [extensionFactory],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	await harness.session.bindExtensions({});
	return {
		...harness,
		async cleanup() {
			await harness.cleanup();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

describe("#470/#471 reentrant bridge calls do not deadlock on the agent event queue", () => {
	it("settles a tool calling executeTool while the parent stream holds the queue", async () => {
		const queueHeld = deferred();
		const releaseQueue = deferred();
		const bridgeFinished = deferred();
		const sessionHolder: { current?: AgentSession } = {};
		const extensionFactory: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "child_tool",
				label: "Child Tool",
				description: "Nested bridge target.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "child-ok" }], details: {} }),
			});
			pi.registerTool({
				name: "parent_tool",
				label: "Parent Tool",
				description: "Streams, then bridges into a nested tool.",
				parameters: Type.Object({}),
				execute: async (_toolCallId, _params, _signal, onUpdate) => {
					onUpdate?.({ content: [{ type: "text", text: "streaming" }], details: {} });
					await queueHeld.promise;
					const session = sessionHolder.current;
					if (!session) throw new Error("session not bound");
					const child = await session.executeTool("child_tool", {});
					bridgeFinished.resolve();
					const text = child.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("");
					return { content: [{ type: "text", text: `parent:${text}` }], details: {} };
				},
			});
			pi.on("tool_execution_update", async () => {
				queueHeld.resolve();
				await releaseQueue.promise;
			});
		};
		const harness = await createBridgeHarness(extensionFactory);
		sessionHolder.current = harness.session;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("parent_tool", {}), { stopReason: "toolUse" }),
				(_context) => fauxAssistantMessage("done", { stopReason: "stop" }),
			]);

			// given the parent tool streams and its update handler seizes the event queue
			const prompt = harness.session.prompt("go");
			await queueHeld.promise;

			// when the parent's reentrant bridge call runs, it must settle despite the held queue
			const deadlock = new Promise<{ kind: "deadlock" }>((res) => {
				timer = setTimeout(() => res({ kind: "deadlock" }), 2_000);
			});
			const outcome = await Promise.race([
				bridgeFinished.promise.then(() => ({ kind: "settled" as const })),
				deadlock,
			]);
			if (timer !== undefined) clearTimeout(timer);

			releaseQueue.resolve();
			await prompt;

			// then the bridge completes and the parent result flows back to the assistant
			expect(outcome.kind).toBe("settled");
			expect(getAssistantTexts(harness).join("\n")).toContain("done");
		} finally {
			harness.cleanup();
		}
	}, 30_000);
});
