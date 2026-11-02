import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

const WARNING = "queued_input_outlived_run";
const HARD_ERROR = "invalid_request_error: the request was malformed";
const IMAGE = { type: "image", data: "aGk=", mimeType: "image/png" } as const;

function sessionLogLines(harness: Harness): Array<Record<string, unknown>> {
	let raw: string;
	try {
		raw = readFileSync(join(harness.tempDir, "agent", "logs", "session.log"), "utf-8").trim();
	} catch {
		return [];
	}
	return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function outlivedWarnings(harness: Harness): Array<Record<string, unknown>> {
	return sessionLogLines(harness).filter((line) => line.event === WARNING);
}

async function settle(harness: Harness): Promise<void> {
	await harness.session.waitForIdle();
	await harness.session.waitForSettledSessionWork();
}

async function runTurn(harness: Harness, text: string): Promise<void> {
	await harness.session.prompt(text).catch(() => undefined);
	await settle(harness);
}

describe("#4036 a queued input that outlives a completed turn is reported, and only then", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given a steer queued while idle #when the next turn delivers it #then nothing is reported", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled"), fauxAssistantMessage("handled again")]);
		await harness.session.steer("steer queued while idle");

		// when
		await runTurn(harness, "an ordinary turn");
		await runTurn(harness, "another ordinary turn");

		// then
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(outlivedWarnings(harness)).toEqual([]);
	});

	it("#given a steer whose delivery was lost #when a whole turn starts and ends normally without it #then a warning carries its age, mode and source, once", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled"), fauxAssistantMessage("handled again")]);
		await harness.session.steer("steer the agent never receives");
		harness.session.agent.clearAllQueues();

		// when
		await runTurn(harness, "an ordinary turn");
		await runTurn(harness, "another ordinary turn");

		// then
		expect(harness.session.getSteeringMessages()).toEqual(["steer the agent never receives"]);
		const warnings = outlivedWarnings(harness);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ level: "warn", mode: "steer", source: "interactive" });
		expect(warnings[0]?.queuedId).toEqual(expect.any(String));
		expect(warnings[0]?.ageMs).toEqual(expect.any(Number));
	});

	it("#given a follow-up queued while idle #when the next turn fails #then nothing is reported and the turn after delivers it once", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: HARD_ERROR }),
			fauxAssistantMessage("handled the turn after"),
			fauxAssistantMessage("handled the follow-up"),
			fauxAssistantMessage("unexpected extra turn"),
		]);
		await harness.session.followUp("follow-up queued while idle");

		// when
		await runTurn(harness, "a turn that fails");
		await runTurn(harness, "the turn after");

		// then
		expect(getUserTexts(harness).filter((text) => text === "follow-up queued while idle")).toHaveLength(1);
		expect(outlivedWarnings(harness)).toEqual([]);
	});

	it("#given an accepted compaction and a steer sent while the next prompt starts #when that turn is aborted by the provider #then nothing is reported and the next turn delivers it once", async () => {
		// given
		const promptStarting = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		const harness = await createHarness({
			models: [{ id: "issue-4036-aborted", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "accepted summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("before_agent_start", async (event) => {
						if (event.prompt !== "a turn that is aborted") return;
						promptStarting.resolve();
						await releasePrompt.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed context ".repeat(40));
		const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
		if (typeof runAutoCompaction !== "function") throw new Error("Expected AgentSession._runAutoCompaction");
		await runAutoCompaction.call(harness.session, "threshold", false);
		harness.setResponses([
			{
				...fauxAssistantMessage("aborted response"),
				stopReason: "aborted",
				errorMessage: "provider stream aborted",
			},
			fauxAssistantMessage("handled the steer"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		// when
		const prompt = harness.session.prompt("a turn that is aborted").catch(() => undefined);
		await promptStarting.promise;
		await harness.session.prompt("steer sent while the prompt started", { streamingBehavior: "steer" });
		releasePrompt.resolve();
		await prompt;
		await settle(harness);
		await runTurn(harness, "the next turn");

		// then
		expect(getUserTexts(harness).filter((text) => text === "steer sent while the prompt started")).toHaveLength(1);
		expect(outlivedWarnings(harness)).toEqual([]);
	});

	it("#given a follow-up queued during a turn #when that turn retries a transient error and then fails #then nothing is reported and the next turn delivers it once", async () => {
		// given
		const harness = await createHarness({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });
		harnesses.push(harness);
		let followUpQueued: Promise<unknown> | undefined;
		harness.setResponses([
			() => {
				followUpQueued = harness.session.followUp("follow-up queued during the turn");
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			},
			fauxAssistantMessage("", { stopReason: "error", errorMessage: HARD_ERROR }),
			fauxAssistantMessage("handled the next turn"),
			fauxAssistantMessage("handled the follow-up"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		// when
		await runTurn(harness, "a turn that retries and fails");
		await followUpQueued;
		await runTurn(harness, "the next turn");

		// then
		expect(getUserTexts(harness).filter((text) => text === "follow-up queued during the turn")).toHaveLength(1);
		expect(outlivedWarnings(harness)).toEqual([]);
	});

	it("#given an image-only steer queued while idle #when the next turn delivers it #then it leaves the queue and nothing is reported", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled"), fauxAssistantMessage("handled again")]);
		await harness.session.steer("", [IMAGE]);

		// when
		await runTurn(harness, "an ordinary turn");
		await runTurn(harness, "another ordinary turn");

		// then
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(outlivedWarnings(harness)).toEqual([]);
	});
	it("#given a steer whose delivery was lost #when a later turn is aborted during its retry backoff #then that aborted settle reports nothing and the next normal turn reports it once", async () => {
		// given
		const harness = await createHarness({ settings: { retry: { enabled: true, baseDelayMs: 60_000 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("handled"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("handled the turn after the abort"),
			fauxAssistantMessage("unexpected extra turn"),
		]);
		await runTurn(harness, "an ordinary turn");
		await harness.session.steer("steer the agent never receives");
		harness.session.agent.clearAllQueues();
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") void harness.session.abort();
		});

		// when
		await runTurn(harness, "a turn whose retry is aborted");
		unsubscribe();
		const warningsAfterTheAbortedSettle = outlivedWarnings(harness).length;
		await runTurn(harness, "the turn after the abort");

		// then
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(warningsAfterTheAbortedSettle).toBe(0);
		expect(outlivedWarnings(harness)).toHaveLength(1);
	});
});
