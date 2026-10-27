import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/core/compaction/compaction.ts";
import { projectModelUsabilityBudget } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { filterContextExcludedMessages } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

// https://github.com/code-yeongyu/senpi/issues/3447
// The fallback repair and the switch guard must charge one measure of the live
// context: the provider-reported usage when a provider reported it for the
// current context, otherwise the per-message estimate, and never less than that
// estimate. Without reported usage the guard's figure used to subtract the system
// prompt and tool schemas from an estimate that never contained them.
const primary = "faux/faux-roomy";
const usageLimit = "billing error: insufficient_quota for this model";
const reportMaxTokens = 8_000;

interface Seed {
	readonly steps: number;
	readonly resultChars: number;
	readonly reportedInput?: number;
	readonly compactedPrefixSteps?: number;
}

function usage(input: number) {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost };
}

function appendSteps(harness: Harness, steps: number, resultChars: number, reportedInput: number, tag: string): void {
	const model = harness.getModel();
	for (let step = 0; step < steps; step++) {
		const toolCallId = `${tag}-${step}`;
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("running a tool"),
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `${tag} ${step}` } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: usage(step === steps - 1 ? reportedInput : 0),
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: `${tag}${step} `.padEnd(resultChars, "z") }],
			isError: false,
			timestamp: Date.now(),
		});
	}
}

function seed(harness: Harness, shape: Seed): void {
	harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "do the task" }], timestamp: 1 });
	if (shape.compactedPrefixSteps !== undefined) {
		appendSteps(harness, shape.compactedPrefixSteps, 400, 90_000, "old");
		const firstKept = harness.sessionManager.getBranch().at(-1);
		if (!firstKept) throw new Error("missing compaction boundary fixture");
		harness.sessionManager.appendCompaction("earlier work summary", firstKept.id, 90_000);
	}
	appendSteps(harness, shape.steps, shape.resultChars, shape.reportedInput ?? 0, "new");
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function contextEstimate(harness: Harness): number {
	return filterContextExcludedMessages(harness.sessionManager.buildSessionContext().messages).reduce(
		(total, message) => total + estimateTokens(message),
		0,
	);
}

// A rung window between the old, prefix-subtracted charge and the true one: the
// old measure says it fits now, the one measure says it needs a reduction.
async function gapWindow(shape: Seed): Promise<number> {
	const probe = await createHarness({ models: [{ id: "faux-roomy", contextWindow: 400_000, maxTokens: 32_000 }] });
	try {
		seed(probe, shape);
		const project = (contextWindow: number) =>
			projectModelUsabilityBudget({
				model: { ...probe.getModel(), contextWindow, maxTokens: reportMaxTokens },
				systemPrompt: probe.session.agent.state.systemPrompt,
				tools: probe.session.agent.state.tools,
				liveContextTokens: contextEstimate(probe),
				compaction: probe.settingsManager.getCompactionSettings(),
				includeSpeculationLead: false,
				admission: "switch",
			});
		let window = 1_000_000;
		for (let round = 0; round < 6; round++) {
			const projection = project(window);
			const prefix = projection.systemPromptTokens + projection.activeToolSchemaTokens;
			window = projection.requiredTokens - Math.floor(prefix / 2);
		}
		const atWindow = project(window);
		if (atWindow.usable) throw new Error(`gap fixture: ${window} already fits ${atWindow.requiredTokens}`);
		return window;
	} finally {
		probe.cleanup();
	}
}

const rows: readonly { readonly name: string; readonly shape: Seed; readonly resumed?: boolean }[] = [
	{ name: "no reported usage", shape: { steps: 20, resultChars: 8_000 } },
	{ name: "a resumed session without reported usage", shape: { steps: 20, resultChars: 8_000 }, resumed: true },
	{
		name: "a compaction whose next request failed",
		shape: { steps: 20, resultChars: 8_000, compactedPrefixSteps: 6 },
	},
];

describe("#3447 fallback fit charges one measure with and without reported usage", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function sessionFor(
		row: (typeof rows)[number],
		rungWindow: number,
		rungMaxTokens: number,
		primaryWindow = 400_000,
	): Promise<Harness> {
		const options = {
			models: [
				{ id: "faux-roomy", contextWindow: primaryWindow, maxTokens: 32_000 },
				{ id: "faux-rung", contextWindow: rungWindow, maxTokens: rungMaxTokens },
			],
			settings: {
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 60_000, fallbackChains: { [primary]: ["faux/faux-rung"] } },
			},
		};
		const first = await createHarness(options);
		harnesses.push(first);
		seed(first, row.shape);
		if (!row.resumed) return first;
		const resumed = await createHarness({ ...options, siblingOf: first, sessionManager: first.sessionManager });
		harnesses.push(resumed);
		resumed.session.agent.state.messages = resumed.sessionManager.buildSessionContext().messages;
		return resumed;
	}

	it.each(rows)("#given $name and a rung only a reduction fits #when fallback switches #then it reduces once and the rung answers", async (row) => {
		const harness = await sessionFor(row, await gapWindow(row.shape), reportMaxTokens);
		const seededEstimate = contextEstimate(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit }),
			fauxAssistantMessage("answer from the rung"),
		]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("model_change_rejected")).toEqual([]);
		const reduced = harness.eventsOfType("resume_context_reduced");
		expect(reduced).toHaveLength(1);
		expect(reduced[0]?.tokensBefore).toBeGreaterThanOrEqual(seededEstimate);
		expect(harness.session.model?.id).toBe("faux-rung");
	});

	it.each(rows)("#given $name and a rung that cannot hold it #when the guard refuses #then it charges the full per-message estimate", async (row) => {
		const harness = await sessionFor(row, 30_000, 4_000);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit })]);

		await harness.session.prompt("continue");

		const [rejected] = harness.eventsOfType("model_change_rejected");
		expect(rejected?.liveContextTokens).toBe(contextEstimate(harness));
	});

	it("#given a reported figure implausibly above a large estimate #when fallback switches to a rung the estimate fits #then it switches without cutting the context", async () => {
		const shape: Seed = { steps: 30, resultChars: 2_000, reportedInput: 600_000 };
		const harness = await sessionFor({ name: "spike", shape }, 200_000, reportMaxTokens, 5_000_000);
		expect(contextEstimate(harness) * 8).toBeLessThan(600_000);
		expect(contextEstimate(harness)).toBeGreaterThanOrEqual(50_000);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: usageLimit }),
			fauxAssistantMessage("answer from the rung"),
		]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("resume_context_reduced")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-rung");
	});
});
