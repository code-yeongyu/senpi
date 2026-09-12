import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Model, registerFauxProvider, type Tool } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import {
	type ModelUsabilityBudgetProjection,
	projectModelUsabilityBudget,
} from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import {
	type CustomEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
	TEST_DIR,
	"..",
	"fixtures",
	"compaction",
	"model-usability",
	"switch-budget-projection.jsonl",
);

interface BudgetCandidate {
	readonly label: string;
	readonly provider: string;
	readonly modelId: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
}

interface BudgetFixtureData {
	readonly systemPrompt: string;
	readonly tools: readonly Tool[];
	readonly candidates: readonly BudgetCandidate[];
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

let fixtureEntries: SessionEntry[] = [];
let budgetFixture: BudgetFixtureData;
let liveContextTokens = 0;

function readLiveContextTokens(entries: readonly SessionEntry[]): number {
	let tokens = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = (entry as SessionMessageEntry).message;
		if (message.role !== "assistant" || !message.usage) continue;
		const usage = message.usage;
		tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return tokens;
}

function candidate(label: string): BudgetCandidate {
	const found = budgetFixture.candidates.find((entry) => entry.label === label);
	if (!found) throw new Error(`fixture candidate "${label}" is missing`);
	return found;
}

function projectCandidate(label: string, options?: { liveContextTokens?: number }): ModelUsabilityBudgetProjection {
	const target = candidate(label);
	const registration = registerFauxProvider({
		provider: target.provider,
		models: [{ id: target.modelId, contextWindow: target.contextWindow, maxTokens: target.maxTokens }],
	});
	registrations.push(registration);
	const model = registration.getModel(target.modelId) as Model<string> | undefined;
	if (!model) throw new Error(`faux model "${target.modelId}" was not registered`);

	return projectModelUsabilityBudget({
		model,
		systemPrompt: budgetFixture.systemPrompt,
		tools: budgetFixture.tools,
		liveContextTokens: options?.liveContextTokens,
		compaction: DEFAULT_COMPACTION_SETTINGS,
	});
}

beforeAll(() => {
	const entries = parseSessionEntries(readFileSync(FIXTURE_PATH, "utf-8"));
	migrateSessionEntries(entries);
	fixtureEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const budgetEntry = fixtureEntries.find(
		(entry): entry is CustomEntry<BudgetFixtureData> =>
			entry.type === "custom" && entry.customType === "model-usability-budget",
	);
	if (!budgetEntry?.data) throw new Error("fixture is missing its model-usability-budget entry");
	budgetFixture = budgetEntry.data;
	liveContextTokens = readLiveContextTokens(fixtureEntries);
});

describe("compaction policy: model usability budget", () => {
	describe("Given the fixture session's live context on a large-window model", () => {
		describe("When the model usability budget is projected", () => {
			it("Then the model is usable with no shortfall", () => {
				// when
				const projection = projectCandidate("comfortable", { liveContextTokens });

				// then
				expect(liveContextTokens).toBe(25_000);
				expect(projection).toMatchObject({
					model: "faux/faux-comfortable",
					contextWindow: 200_000,
					liveContextTokens: 25_000,
					systemPromptTokens: 15,
					activeToolSchemaTokens: 88,
					outputReserveTokens: 32_000,
					compactionReserveTokens: 16_384,
					speculationLeadTokens: 17_500,
					safetyMarginTokens: 8_192,
					requiredTokens: 99_179,
					shortfallTokens: 0,
					usable: true,
				});
			});
		});
	});

	describe("Given the same live context on the fixture's small-window switch target", () => {
		describe("When the model usability budget is projected", () => {
			it("Then the model is unusable by exactly the fixture's shortfall", () => {
				// when
				const projection = projectCandidate("shortfall", { liveContextTokens });

				// then
				expect(projection).toMatchObject({
					model: "faux/faux-shortfall",
					contextWindow: 48_000,
					liveContextTokens: 25_000,
					outputReserveTokens: 8_000,
					compactionReserveTokens: 16_384,
					speculationLeadTokens: 8_192,
					safetyMarginTokens: 8_192,
					requiredTokens: 65_871,
					shortfallTokens: 17_871,
					usable: false,
				});
			});
		});
	});

	describe("Given that same small-window target before the session accumulated live context", () => {
		describe("When the model usability budget is projected with no live context", () => {
			it("Then the shortfall disappears, so the fixture's shortfall is live-context driven", () => {
				// when
				const projection = projectCandidate("shortfall");

				// then
				expect(projection).toMatchObject({
					liveContextTokens: 0,
					requiredTokens: 40_871,
					shortfallTokens: 0,
					usable: true,
				});
			});
		});
	});

	describe("Given two fixture models with identical geometry but different families", () => {
		describe("When both model usability budgets are projected", () => {
			it("Then the anthropic family reserves 16384 and the default profile reserves 8192", () => {
				// when
				const anthropicProjection = projectCandidate("anthropic-profile", { liveContextTokens });
				const defaultProjection = projectCandidate("default-profile", { liveContextTokens });

				// then
				expect(anthropicProjection).toMatchObject({
					safetyMarginProfile: "anthropic",
					safetyMarginTokens: 16_384,
					requiredTokens: 107_371,
				});
				expect(defaultProjection).toMatchObject({
					safetyMarginProfile: "default",
					safetyMarginTokens: 8_192,
					requiredTokens: 99_179,
				});
				expect(anthropicProjection.contextWindow).toBe(defaultProjection.contextWindow);
				expect(anthropicProjection.outputReserveTokens).toBe(defaultProjection.outputReserveTokens);
				expect(anthropicProjection.compactionReserveTokens).toBe(defaultProjection.compactionReserveTokens);
				expect(anthropicProjection.speculationLeadTokens).toBe(defaultProjection.speculationLeadTokens);
				expect(anthropicProjection.requiredTokens - defaultProjection.requiredTokens).toBe(8_192);
			});
		});
	});
});
