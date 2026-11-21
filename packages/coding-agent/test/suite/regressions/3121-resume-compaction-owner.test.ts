import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateContextTokens, fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { ModelUsabilityBudgetError } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * #3121: with `compaction.enabled: false` and an extension that owns compaction
 * (a `session_before_compact` handler), an oversized session could not be
 * resumed: admission refused it as if nothing could compact, and the first
 * prompt never reached the owner. A registered owner now makes the session
 * compaction-capable for resume admission; the first prompt then drains the
 * recorded requirement through the owner.
 */
const CONTEXT_WINDOW = 100_000;
const MAX_TOKENS = 4_000;

function ownerExtension(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event) => ({
		compaction: {
			summary: "owner summary",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		},
	}));
}

function seedOverBudgetTranscript(harness: Harness): void {
	const model = harness.getModel();
	// About 89K tokens in a 100K window: over the resume budget, still inside the window.
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "restored context ".repeat(21_000) }],
		timestamp: 1,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("restored answer", { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "last request" }],
		timestamp: 3,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("restored answer", { timestamp: 4 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
}

async function resumeWithCompactionDisabled(harness: Harness, dirName: string, withOwner: boolean) {
	const agentDir = join(harness.tempDir, dirName);
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1 } }),
	);
	const settingsManager = SettingsManager.create(harness.tempDir, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: harness.tempDir,
		agentDir,
		settingsManager,
		extensionFactories: withOwner ? [ownerExtension] : [],
	});
	await resourceLoader.reload();
	return createAgentSession({
		cwd: harness.tempDir,
		agentDir,
		model: harness.getModel(),
		modelRuntime: getModelRuntime(harness.modelRegistry),
		sessionManager: harness.sessionManager,
		settingsManager,
		resourceLoader,
	});
}

describe("#3121 resume with compaction disabled and a registered compaction owner", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function overBudgetHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "resume", contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS }],
			persistSession: true,
		});
		harnesses.push(harness);
		seedOverBudgetTranscript(harness);
		return harness;
	}

	it("admits the resume and the owner compacts before the first provider request", async () => {
		const harness = await overBudgetHarness();

		const resumed = await resumeWithCompactionDisabled(harness, "owner-agent", true);
		const events: unknown[] = [];
		resumed.session.subscribe((event) => events.push(event));
		await resumed.session.bindExtensions({});

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "resume_compaction_required",
				projection: expect.objectContaining({ usable: false, admission: "resume" }),
			}),
		);

		harness.setResponses([fauxAssistantMessage("first answer")]);
		await resumed.session.prompt("continue");

		expect(events).toContainEqual(expect.objectContaining({ type: "compaction_end", accepted: true }));
		const compactions = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions.map((entry) => entry.summary)).toEqual(["owner summary"]);
		const providerCall = harness.faux.getCallLog().at(-1);
		if (!providerCall) throw new Error("expected a provider request after the owner compacted");
		expect(estimateContextTokens(normalizeContext(providerCall.context)).tokens).toBeLessThanOrEqual(
			CONTEXT_WINDOW - MAX_TOKENS,
		);
		resumed.session.dispose();
	});

	it("keeps refusing when no extension owns compaction", async () => {
		const harness = await overBudgetHarness();

		await expect(resumeWithCompactionDisabled(harness, "no-owner-agent", false)).rejects.toBeInstanceOf(
			ModelUsabilityBudgetError,
		);
	});
});
