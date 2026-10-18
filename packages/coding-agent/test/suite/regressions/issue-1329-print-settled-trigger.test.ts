import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

const output = vi.hoisted((): { lines: string[] } => ({ lines: [] }));

vi.mock("../../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: (text: string) => output.lines.push(text),
}));

describe("issue #1329: print waits for a settled-event trigger", () => {
	it.each(["normal", "/start-recovery"])("prints the final continuation after %s", async (initialMessage) => {
		// Given: settlement starts a continuation held at admission and provider entry.
		output.lines = [];
		const hookEntered = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const providerEntered = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt !== "issue-1329-continuation") return;
						hookEntered.resolve();
						await releaseHook.promise;
					});
					const sendContinuation = () => {
						if (sent) return;
						sent = true;
						pi.sendMessage(
							{ customType: "issue-1329-recovery", content: "issue-1329-continuation", display: false },
							{ triggerTurn: true },
						);
					};
					pi.on("agent_settled", sendContinuation);
					pi.registerCommand("start-recovery", {
						description: "Start the regression continuation",
						handler: async () => sendContinuation(),
					});
				},
			],
		});
		harness.setResponses([
			...(initialMessage === "normal" ? [fauxAssistantMessage("ISSUE_1329_PRECEDING")] : []),
			async () => {
				providerEntered.resolve();
				await releaseProvider.promise;
				return fauxAssistantMessage("ISSUE_1329_FINAL");
			},
		]);
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: join(harness.tempDir, "agent"),
				authStorage: harness.authStorage,
				modelRegistry: harness.modelRegistry,
				modelRuntime: getModelRuntime(harness.modelRegistry),
				settingsManager: harness.settingsManager,
				resourceLoader: createTestResourceLoader(),
				diagnostics: [],
			},
			async () => {
				throw new Error("This scenario does not replace the runtime");
			},
		);

		// When: print mode runs and both continuation gates are released by their events.
		const printed = runPrintMode(runtime, { mode: "text", initialMessage });
		const deadline = Promise.withResolvers<never>();
		const timeout = setTimeout(() => deadline.reject(new Error("Continuation was not reached")), 5_000);
		try {
			await Promise.race([hookEntered.promise, deadline.promise]);
			releaseHook.resolve();
			await Promise.race([providerEntered.promise, deadline.promise]);
			releaseProvider.resolve();

			// Then: only the final continuation is printed.
			expect(await printed).toBe(0);
			expect(output.lines.join("")).toBe("ISSUE_1329_FINAL\n");
		} finally {
			clearTimeout(timeout);
			releaseHook.resolve();
			releaseProvider.resolve();
			await printed;
			harness.cleanup();
		}
	});
});
