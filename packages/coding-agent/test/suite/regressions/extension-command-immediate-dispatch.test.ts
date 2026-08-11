import { setImmediate as waitForImmediate } from "node:timers/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

type SessionWorkBarrier = {
	readonly hasActiveWork: boolean;
	begin(): () => void;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

function continuationExtension(pi: ExtensionAPI): void {
	let queued = false;
	pi.on("agent_end", async () => {
		if (queued) return;
		queued = true;
		await waitForImmediate();
		pi.sendMessage(
			{ customType: "test-continuation", content: "continue the test", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});
}

function commandExtension(commandRuns: string[]) {
	return (pi: ExtensionAPI): void => {
		pi.registerCommand("testcmd", {
			description: "Test command",
			handler: async (args) => {
				commandRuns.push(args);
			},
		});
	};
}

function getSessionWorkBarrier(harness: Harness): SessionWorkBarrier {
	const barrier = Reflect.get(harness.session, "_sessionWorkBarrier");
	if (
		!barrier ||
		typeof barrier !== "object" ||
		!("hasActiveWork" in barrier) ||
		!("begin" in barrier) ||
		typeof barrier.begin !== "function"
	) {
		throw new Error("Expected AgentSession._sessionWorkBarrier");
	}
	return barrier as SessionWorkBarrier;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 250): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

describe("extension command immediate dispatch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("dispatches during a barrier-held continuation run", async () => {
		const commandRuns: string[] = [];
		const toolStarted = createDeferred();
		const toolRelease = createDeferred();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await toolRelease.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [continuationExtension, commandExtension(commandRuns)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("turn one done"),
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continuation completed"),
		]);

		const runPromise = harness.session.prompt("start");
		await toolStarted.promise;
		expect(harness.session.isStreaming).toBe(true);
		expect(getSessionWorkBarrier(harness).hasActiveWork).toBe(true);

		const userTextsBeforeCommand = getUserTexts(harness);
		const preflightResults: boolean[] = [];
		const dispositions: string[] = [];
		const commandPrompt = harness.session.prompt("/testcmd now", {
			preflightResult: (accepted) => preflightResults.push(accepted),
			promptDisposition: (disposition) => dispositions.push(disposition),
		});

		try {
			expect(await settlesWithin(commandPrompt), "command prompt must resolve before the run is released").toBe(
				true,
			);
			expect(commandRuns).toEqual(["now"]);
			expect(getUserTexts(harness)).toEqual(userTextsBeforeCommand);
			expect(preflightResults).toEqual([true]);
			expect(dispositions).toEqual(["handled"]);
			expect(harness.session.isStreaming).toBe(true);
		} finally {
			toolRelease.resolve();
			await Promise.allSettled([runPromise, commandPrompt]);
		}

		await harness.session.waitForIdle();
		expect(getAssistantTexts(harness)).toContain("continuation completed");
	});

	it("dispatches while compaction is blocked in session_before_compact", async () => {
		const commandRuns: string[] = [];
		const compactionStarted = createDeferred();
		const compactionRelease = createDeferred();
		const harness = await createHarness({
			models: [{ id: "tiny-context", contextWindow: 128, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 64, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted.resolve();
						await compactionRelease.promise;
						return {
							compaction: {
								summary: "blocked compaction summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
				commandExtension(commandRuns),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("prompt completed after compaction")]);

		const runPromise = harness.session.prompt("initial prompt ".repeat(120));
		await compactionStarted.promise;
		expect(harness.session.isCompacting).toBe(true);

		const userTextsBeforeCommand = getUserTexts(harness);
		const preflightResults: boolean[] = [];
		const dispositions: string[] = [];
		const commandPrompt = harness.session.prompt("/testcmd during-compaction", {
			preflightResult: (accepted) => preflightResults.push(accepted),
			promptDisposition: (disposition) => dispositions.push(disposition),
		});

		try {
			expect(await settlesWithin(commandPrompt), "command prompt must resolve before compaction is released").toBe(
				true,
			);
			expect(commandRuns).toEqual(["during-compaction"]);
			expect(getUserTexts(harness)).toEqual(userTextsBeforeCommand);
			expect(preflightResults).toEqual([true]);
			expect(dispositions).toEqual(["handled"]);
			expect(harness.session.isCompacting).toBe(true);
		} finally {
			compactionRelease.resolve();
			await Promise.allSettled([runPromise, commandPrompt]);
		}

		expect(getAssistantTexts(harness)).toContain("prompt completed after compaction");
	});

	it("dispatches while idle with session work held", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({ extensionFactories: [commandExtension(commandRuns)] });
		harnesses.push(harness);
		const barrier = getSessionWorkBarrier(harness);
		const finishHeldWork = barrier.begin();
		expect(harness.session.isStreaming).toBe(false);
		expect(barrier.hasActiveWork).toBe(true);

		const userTextsBeforeCommand = getUserTexts(harness);
		const preflightResults: boolean[] = [];
		const dispositions: string[] = [];
		const commandPrompt = harness.session.prompt("/testcmd idle-work", {
			preflightResult: (accepted) => preflightResults.push(accepted),
			promptDisposition: (disposition) => dispositions.push(disposition),
		});

		try {
			expect(await settlesWithin(commandPrompt), "command prompt must resolve before held work is released").toBe(
				true,
			);
			expect(commandRuns).toEqual(["idle-work"]);
			expect(getUserTexts(harness)).toEqual(userTextsBeforeCommand);
			expect(preflightResults).toEqual([true]);
			expect(dispositions).toEqual(["handled"]);
			expect(barrier.hasActiveWork).toBe(true);
		} finally {
			finishHeldWork();
			await Promise.allSettled([commandPrompt]);
		}
	});
});
