import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/core/compaction/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/rpc-session-state.ts";
import { createHarness, type Harness } from "../harness.ts";

// oh-my-openagent#11684: after a model switch, the last usage was measured by the previous model's
// tokenizer, so it must not be presented (or gate compaction) as the new model's count.

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const WINDOWS = { "model-a": 1_000_000, "model-b": 500_000, "model-c": 500_000 } as const;
type ModelId = keyof typeof WINDOWS;
const RESERVE_TOKENS = 16_000;

async function setup(options: { compaction?: boolean; onCompact?: (reason: string) => void } = {}): Promise<Harness> {
	const harness = await createHarness({
		models: Object.entries(WINDOWS).map(([id, contextWindow]) => ({ id, contextWindow, maxTokens: 4_000 })),
		settings: {
			compaction: {
				enabled: options.compaction === true,
				speculativeEnabled: false,
				idleCompactionEnabled: false,
				keepRecentTokens: 2_000,
				reserveTokens: RESERVE_TOKENS,
			},
			retry: { enabled: false },
		},
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event) => {
					options.onCompact?.(event.reason);
					return { cancel: true, rejectionCause: "external-owner", reason: "observed only" };
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return harness;
}

function model(harness: Harness, id: ModelId) {
	const found = harness.getModel(id);
	if (!found) throw new Error(`missing faux model ${id}`);
	return found;
}

/** A turn answered by `id` whose provider reported `contextTokens` (the faux stream would estimate its own). */
function seedTurn(harness: Harness, id: ModelId, prompt: string, contextTokens: number): void {
	const answering = model(harness, id);
	const answer = fauxAssistantMessage("reply");
	harness.sessionManager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
	harness.sessionManager.appendMessage({
		...answer,
		api: answering.api,
		provider: answering.provider,
		model: answering.id,
		usage: { ...answer.usage, input: contextTokens, totalTokens: contextTokens },
	});
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function transcriptEstimate(harness: Harness): number {
	return harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

describe("#11684: context usage after a model switch", () => {
	it.each([
		["model-a", "model-b"],
		["model-b", "model-a"],
		["model-b", "model-c"],
	] as const)("does not present %s's usage as %s's until the new model reports usage", async (from, to) => {
		const harness = await setup();
		await harness.session.setModel(model(harness, from));
		seedTurn(harness, from, "hello", 304_000);
		expect(harness.session.getContextUsage()).toEqual({
			tokens: 304_000,
			contextWindow: WINDOWS[from],
			percent: (304_000 / WINDOWS[from]) * 100,
		});

		await harness.session.setModel(model(harness, to));

		const estimate = transcriptEstimate(harness);
		const switched = {
			tokens: estimate,
			contextWindow: WINDOWS[to],
			percent: (estimate / WINDOWS[to]) * 100,
			estimated: true,
		};
		expect(harness.session.getContextUsage()).toEqual(switched);
		expect(buildRpcSessionState(harness.session).contextUsage).toEqual(switched);

		seedTurn(harness, to, "again", 172_000);
		expect(harness.session.getContextUsage()).toEqual({
			tokens: 172_000,
			contextWindow: WINDOWS[to],
			percent: (172_000 / WINDOWS[to]) * 100,
		});
	});

	it("passes the switch boundary to provider requests so request-time context checks skip older usage", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("hello");
		expect(harness.faux.getCallLog()[0]?.options?.contextUsageNotBefore).toBeUndefined();

		await harness.session.setModel(model(harness, "model-b"));
		const switchEntry = harness.sessionManager.getBranch().findLast((entry) => entry.type === "model_change");
		if (!switchEntry) throw new Error("the switch recorded no model_change entry");
		harness.setResponses([fauxAssistantMessage("second")]);
		await harness.session.prompt("again");

		expect(harness.faux.getCallLog()[1]?.options?.contextUsageNotBefore).toBe(
			new Date(switchEntry.timestamp).getTime(),
		);
	});

	it("gates compaction on the corrected count, not on the previous model's lower usage", async () => {
		const reasons: string[] = [];
		const harness = await setup({ compaction: true, onCompact: (reason) => reasons.push(reason) });
		await harness.session.setModel(model(harness, "model-a"));
		// The previous model's tokenizer counted this transcript far lower than its content estimate.
		seedTurn(harness, "model-a", "context ".repeat(245_000), 100_000);

		await harness.session.setModel(model(harness, "model-b"));
		expect(harness.session.getContextUsage()?.tokens).toBeGreaterThan(WINDOWS["model-b"] - RESERVE_TOKENS);
		harness.setResponses([fauxAssistantMessage("after")]);
		await harness.session.prompt("next").catch(() => undefined);

		expect(reasons.length).toBeGreaterThan(0);
	});
});
