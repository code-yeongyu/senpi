import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const FIRST_PROMPT = "first prompt after the compaction";
const STEER = "steer sent while the first prompt after the compaction was starting";
const HARD_ERROR = "invalid_request_error: the request was malformed";

type FirstPromptHold = "before_agent_start" | "input-handled";

interface AcceptedCompactionOptions {
	readonly thresholdCompaction: boolean;
	readonly hold?: FirstPromptHold;
	readonly retry?: { readonly enabled: boolean; readonly maxRetries?: number; readonly baseDelayMs?: number };
}

interface AcceptedCompaction {
	readonly harness: Harness;
	readonly promptStarting: Promise<void>;
	readonly releasePrompt: () => void;
}

function createEchoTool(): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			return { content: [{ type: "text", text }], details: { text } };
		},
	};
}

async function createAcceptedCompaction(options: AcceptedCompactionOptions): Promise<AcceptedCompaction> {
	const starting = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const hold = options.hold ?? "before_agent_start";
	const harness = await createHarness({
		models: [{ id: "issue-4036", contextWindow: 128_000, maxTokens: 64 }],
		tools: [createEchoTool()],
		settings: {
			compaction: { enabled: options.thresholdCompaction, reserveTokens: 16_384, keepRecentTokens: 1 },
			...(options.retry === undefined ? {} : { retry: options.retry }),
		},
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
					if (hold !== "before_agent_start" || event.prompt !== FIRST_PROMPT) return;
					starting.resolve();
					await release.promise;
				});
				pi.on("input", async (event) => {
					if (hold !== "input-handled" || event.text !== FIRST_PROMPT) return { action: "continue" as const };
					starting.resolve();
					await release.promise;
					return { action: "handled" as const };
				});
			},
		],
	});
	harness.setResponses([fauxAssistantMessage("seed response")]);
	await harness.session.prompt("seed context ".repeat(40));
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") throw new Error("Expected AgentSession._runAutoCompaction");
	await runAutoCompaction.call(harness.session, "threshold", false);
	expect(harness.eventsOfType("compaction_end")).toEqual([expect.objectContaining({ accepted: true })]);
	return { harness, promptStarting: starting.promise, releasePrompt: () => release.resolve() };
}

async function runFirstPromptWithSteer(setup: AcceptedCompaction): Promise<string> {
	const { harness } = setup;
	const outcome = harness.session.prompt(FIRST_PROMPT).then(
		() => "resolved",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	await setup.promptStarting;
	await harness.session.prompt(STEER, { streamingBehavior: "steer" });
	setup.releasePrompt();
	const result = await outcome;
	await settle(harness);
	return result;
}

async function settle(harness: Harness): Promise<void> {
	await harness.session.waitForIdle();
	await harness.session.waitForSettledSessionWork();
}

async function runTurn(harness: Harness, text: string): Promise<void> {
	await harness.session.prompt(text);
	await settle(harness);
}

function deliveries(harness: Harness, text: string): number {
	return getUserTexts(harness).filter((candidate) => candidate === text).length;
}

describe("#4036 input held at the start of the first prompt after a compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setUp(options: AcceptedCompactionOptions): Promise<AcceptedCompaction> {
		const setup = await createAcceptedCompaction(options);
		harnesses.push(setup.harness);
		return setup;
	}

	it.each([
		{ thresholdCompaction: "disabled", enabled: false },
		{ thresholdCompaction: "enabled", enabled: true },
	])(
		"#given threshold compaction $thresholdCompaction #when the first response is ordinary #then the steer is delivered in that run, exactly once",
		async ({ enabled }) => {
			// given
			const setup = await setUp({ thresholdCompaction: enabled });
			const { harness } = setup;
			harness.setResponses([
				fauxAssistantMessage("ordinary response after the compaction"),
				fauxAssistantMessage("steer handled"),
				fauxAssistantMessage("later turn handled"),
				fauxAssistantMessage("unexpected extra turn"),
			]);

			// when
			await runFirstPromptWithSteer(setup);
			const deliveredInThatRun = deliveries(harness, STEER);
			await runTurn(harness, "a later ordinary turn");

			// then
			expect(deliveredInThatRun).toBe(1);
			expect(deliveries(harness, STEER)).toBe(1);
			expect(getAssistantTexts(harness)).toContain("steer handled");
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		},
	);

	it.each([
		{ thresholdCompaction: "disabled", enabled: false },
		{ thresholdCompaction: "enabled", enabled: true },
	])(
		"#given threshold compaction $thresholdCompaction #when the first response calls a tool #then the steer is delivered in that run with the tool result, exactly once",
		async ({ enabled }) => {
			// given
			const setup = await setUp({ thresholdCompaction: enabled });
			const { harness } = setup;
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("echo", { text: "tool ran" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("answered after the tool and the steer"),
				fauxAssistantMessage("later turn handled"),
				fauxAssistantMessage("unexpected extra turn"),
			]);

			// when
			await runFirstPromptWithSteer(setup);
			const deliveredInThatRun = deliveries(harness, STEER);
			await runTurn(harness, "a later ordinary turn");

			// then
			expect(deliveredInThatRun).toBe(1);
			expect(deliveries(harness, STEER)).toBe(1);
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		},
	);

	it("#given threshold compaction off #when the first response stops on its length limit #then the steer is delivered in that run", async () => {
		// given
		const setup = await setUp({ thresholdCompaction: false });
		const { harness } = setup;
		harness.setResponses([
			{ ...fauxAssistantMessage("response cut at its length limit"), stopReason: "length" },
			fauxAssistantMessage("steer handled"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		// when
		await runFirstPromptWithSteer(setup);

		// then
		expect(deliveries(harness, STEER)).toBe(1);
		expect(getAssistantTexts(harness)).toContain("steer handled");
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it("#given an accepted compaction #when the first response is aborted by the provider #then the steer is delivered on the next turn exactly once, like ordinary queued input", async () => {
		// given
		const setup = await setUp({ thresholdCompaction: true });
		const { harness } = setup;
		harness.setResponses([
			{
				...fauxAssistantMessage("aborted response after the compaction"),
				stopReason: "aborted",
				errorMessage: "provider stream aborted",
			},
			fauxAssistantMessage("steer handled on the next turn"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		// when
		await runFirstPromptWithSteer(setup);
		await runTurn(harness, "the next turn");

		// then
		expect(deliveries(harness, STEER)).toBe(1);
		expect(getAssistantTexts(harness)).toContain("steer handled on the next turn");
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it.each([
		{ thresholdCompaction: "disabled", enabled: false },
		{ thresholdCompaction: "enabled", enabled: true },
	])(
		"#given threshold compaction $thresholdCompaction #when the first response is aborted after a steer was queued during it #then prompt() does not fail with a required-compaction error",
		async ({ enabled }) => {
			// given
			const setup = await setUp({ thresholdCompaction: enabled });
			const { harness } = setup;
			harness.setResponses([
				async () => {
					await harness.session.prompt("steer queued during the response", { streamingBehavior: "steer" });
					return {
						...fauxAssistantMessage("aborted response after the compaction"),
						stopReason: "aborted",
						errorMessage: "provider stream aborted",
					};
				},
				fauxAssistantMessage("steer handled on the next turn"),
				fauxAssistantMessage("unexpected extra turn"),
			]);

			// when
			const outcome = harness.session.prompt(FIRST_PROMPT).then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			await setup.promptStarting;
			setup.releasePrompt();
			const result = await outcome;
			await settle(harness);

			// then
			expect(result).toBe("resolved");
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		},
	);

	it("#given an accepted compaction #when the first prompt is handled by an input hook without starting a run while a steer joined it #then the joined steer runs, as it does without a compaction", async () => {
		// given
		const setup = await setUp({ thresholdCompaction: true, hold: "input-handled" });
		const { harness } = setup;
		harness.setResponses([
			fauxAssistantMessage("joined steer handled"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		// when
		await runFirstPromptWithSteer(setup);

		// then
		expect(deliveries(harness, STEER)).toBe(1);
		expect(getAssistantTexts(harness)).toContain("joined steer handled");
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});

	it.each([
		{ retryBudget: "retries off", retry: { enabled: false }, failures: 1 },
		{
			retryBudget: "the retry budget exhausted",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			failures: 2,
		},
	])(
		"#given an accepted compaction #when the first response fails with $retryBudget #then the run does not continue and the steer waits for the next prompt, as without a compaction",
		async ({ retry, failures }) => {
			// given
			const setup = await setUp({ thresholdCompaction: true, retry });
			const { harness } = setup;
			const failure = retry.enabled ? "overloaded_error" : HARD_ERROR;
			harness.setResponses([
				...Array.from({ length: failures }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: failure }),
				),
				fauxAssistantMessage("steer handled on the next prompt"),
				fauxAssistantMessage("unexpected extra turn"),
			]);
			const callsBefore = harness.faux.state.callCount;

			// when
			await runFirstPromptWithSteer(setup);
			const callsForTheFailedPrompt = harness.faux.state.callCount - callsBefore;
			const deliveredBeforeTheNextPrompt = deliveries(harness, STEER);
			const queuedBeforeTheNextPrompt = [...harness.session.getSteeringMessages()];
			await runTurn(harness, "the next prompt");

			// then
			expect(callsForTheFailedPrompt).toBe(failures);
			expect(deliveredBeforeTheNextPrompt).toBe(0);
			expect(queuedBeforeTheNextPrompt).toEqual([STEER]);
			expect(deliveries(harness, STEER)).toBe(1);
			expect(harness.session.getSteeringMessages()).toEqual([]);
		},
	);

	it("#given a steer parked at the start of the first prompt #when a newer steer is queued during its first response #then they are delivered in the order they were sent", async () => {
		// given
		const newerSteer = "newer steer queued during the first response";
		const setup = await setUp({ thresholdCompaction: true });
		const { harness } = setup;
		harness.setResponses([
			async () => {
				await harness.session.prompt(newerSteer, { streamingBehavior: "steer" });
				return fauxAssistantMessage([fauxToolCall("echo", { text: "tool ran" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("handled one steer"),
			fauxAssistantMessage("handled the other steer"),
			fauxAssistantMessage("unexpected extra turn"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		// when
		await runFirstPromptWithSteer(setup);

		// then
		const users = getUserTexts(harness);
		expect(deliveries(harness, STEER)).toBe(1);
		expect(deliveries(harness, newerSteer)).toBe(1);
		expect(users.indexOf(STEER)).toBeLessThan(users.indexOf(newerSteer));
	});
});
