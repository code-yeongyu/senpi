import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";
import { writeResumeEffortFixture } from "./resume-effort-fixtures.ts";

const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function fixture(options: Parameters<typeof writeResumeEffortFixture>[1] = {}) {
	const provider = options.provider ?? "openai-codex";
	const modelId = options.modelId ?? "gpt-6-astra";
	const harness = await createHarness({
		provider,
		models: [{ id: modelId, reasoning: true, contextWindow: 600_000, maxTokens: 32_000 }],
		settings: { defaultThinkingLevel: "minimal", compaction: { enabled: false } },
	});
	harnesses.push(harness);
	harness.settingsManager.setModelThinkingLevel(provider, modelId, "low");
	const manager = writeResumeEffortFixture(harness.tempDir, options);
	const resume = async (overrides: Partial<CreateAgentSessionOptions> = {}) => {
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.modelRegistry,
			settingsManager: harness.settingsManager,
			sessionManager: manager,
			resourceLoader: createTestResourceLoader(),
			...overrides,
		});
		sessions.push(session);
		return session;
	};
	return { harness, manager, resume };
}

function inlineEfforts(session: AgentSession): string[] {
	return session.messages.flatMap((message) => (message.role === "configurationUpdate" ? [message.effort] : []));
}

describe("SDK resume effort", () => {
	it.each(["openai", "openai-codex"])(
		"recovers surviving configuration before remembered defaults on %s",
		async (provider) => {
			// Given missing ancestry and an unrelated branch with a different selection.
			const { harness, manager, resume } = await fixture({ provider });
			expect(manager.getBranch().some((entry) => entry.type === "thinking_level_change")).toBe(false);
			expect(manager.buildSessionContext().thinkingLevel).toBe("off");

			// When the real SDK resumes the persisted session.
			const session = await resume();

			// Then local state, durable recovery and inline effort agree, without changing defaults.
			expect(session.thinkingLevel).toBe("xhigh");
			expect(inlineEfforts(session)).toEqual(["xhigh"]);
			expect(manager.buildSessionContext().thinkingLevel).toBe("xhigh");
			expect(harness.settingsManager.getModelThinkingLevel(provider, "gpt-6-astra")).toBe("low");
			expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("minimal");
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Missing persisted fixture");
			const reopened = SessionManager.open(sessionFile);
			expect((await resume({ sessionManager: reopened })).thinkingLevel).toBe("xhigh");
		},
	);

	it.each(["high", "off"] satisfies ThinkingLevel[])(
		"honors explicit %s and reconciles inline effort",
		async (thinkingLevel) => {
			// Given orphaned history with xhigh in its inline configuration.
			const { resume } = await fixture();
			// When a caller explicitly selects another level (the --thinking SDK seam).
			const session = await resume({ thinkingLevel });
			// Then the final positional update does not override that choice on the wire.
			expect(session.thinkingLevel).toBe(thinkingLevel);
			expect(inlineEfforts(session)).toEqual(["xhigh", thinkingLevel]);
		},
	);

	it("honors a model-suffix selection instead of recovering configuration", async () => {
		// Given the CLI's pre-resolved model suffix selection.
		const { harness, resume } = await fixture();
		// When that explicit model/effort is passed to the SDK.
		const session = await resume({
			model: harness.getModel(),
			thinkingLevel: "high",
			thinkingSelection: { level: "high", source: "explicit" },
		});
		// Then it wins both locally and in the inline stream.
		expect(session.thinkingLevel).toBe("high");
		expect(inlineEfforts(session).at(-1)).toBe("high");
	});

	it("persists an explicit override of intact configuration for subsequent resumes", async () => {
		// Given an intact xhigh selection/configuration resumed with explicit high.
		const { resume } = await fixture({ intact: true });
		await resume({ thinkingLevel: "high" });
		// When resumed again without CLI overrides.
		const session = await resume();
		// Then the override remains the durable selection, not just a transient inline update.
		expect(session.thinkingLevel).toBe("high");
		expect(inlineEfforts(session)).toEqual(["xhigh", "high"]);
		expect(session.agent.state.reasoningBaseline).toBe("medium");
	});

	it("preserves intact thinking history and its cache baseline", async () => {
		// Given an intact medium -> xhigh branch and an unrelated max branch.
		const { resume } = await fixture({ intact: true });
		// When resumed without overrides.
		const session = await resume();
		// Then the branch selection and original baseline remain intact.
		expect(session.thinkingLevel).toBe("xhigh");
		expect(session.agent.state.reasoningBaseline).toBe("medium");
		expect(inlineEfforts(session)).toEqual(["xhigh"]);
	});

	it("keeps a later genuine thinking selection ahead of older configuration", async () => {
		// Given reachable high after the surviving xhigh configuration.
		const { manager, resume } = await fixture();
		manager.appendThinkingLevelChange("high", { level: "high", source: "explicit" });
		// When resumed without overrides.
		const session = await resume();
		// Then both local and effective inline state reflect the later selection.
		expect(session.thinkingLevel).toBe("high");
		expect(inlineEfforts(session)).toEqual(["xhigh", "high"]);
	});

	it("recovers configuration before the global default when no per-model memory exists", async () => {
		// Given global low with no remembered per-model level.
		const { resume } = await fixture();
		const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: "low" });
		// When resumed.
		const session = await resume({ settingsManager });
		// Then the session's surviving effort wins.
		expect(session.thinkingLevel).toBe("xhigh");
	});

	it("uses remembered defaults when neither selection nor configuration survives", async () => {
		// Given the orphan branch before its configuration update.
		const { manager, resume } = await fixture();
		manager.branch("reply");
		// When resumed.
		const session = await resume();
		// Then the existing startup fallback remains unchanged.
		expect(session.thinkingLevel).toBe("low");
		expect(inlineEfforts(session)).toEqual([]);
	});

	it("does not apply Astra configuration to an explicit different model", async () => {
		// Given Astra history but an explicit replacement model without remembered effort.
		const { harness, resume } = await fixture();
		const model = { ...harness.getModel(), id: "replacement-model" };
		// When the SDK receives the model override.
		const session = await resume({ model });
		// Then its global default wins, not the prior model's configuration.
		expect(session.model?.id).toBe("replacement-model");
		expect(session.thinkingLevel).toBe("minimal");
	});

	it("does not recover configuration when reasoning is disabled on the model", async () => {
		// Given an explicit model capability override.
		const { harness, resume } = await fixture();
		// When the non-reasoning model resumes.
		const session = await resume({ model: { ...harness.getModel(), reasoning: false } });
		// Then reasoning stays off.
		expect(session.thinkingLevel).toBe("off");
	});

	it("preserves a genuine effort change made after recovery on the next resume", async () => {
		// Given a recovered session followed by a real session-only user selection.
		const { resume } = await fixture();
		const recovered = await resume();
		recovered.setSessionThinkingLevel("high");
		// When the updated session resumes again.
		const session = await resume();
		// Then the later selection wins locally and inline, with no duplicate update.
		expect(session.thinkingLevel).toBe("high");
		expect(inlineEfforts(session)).toEqual(["xhigh", "high"]);
	});

	it.each(["invalid-effort", "", "MAX"])("does not recover invalid effort %j", async (effort) => {
		// Given an unrecognized persisted effort string.
		const { resume } = await fixture({ effort });
		// When resumed.
		const session = await resume();
		// Then the remembered setting, not an invented/clamped recovery, wins.
		expect(session.thinkingLevel).toBe("low");
	});

	it("does not recover an effort excluded by the restored model's supported levels", async () => {
		// Given a model override that does not support xhigh.
		const { harness, resume } = await fixture();
		const model = { ...harness.getModel(), thinkingLevelMap: { low: "low", high: "high" } };
		// When that model is resumed.
		const session = await resume({ model });
		// Then a supported remembered default wins instead of clamping xhigh to high.
		expect(session.thinkingLevel).toBe("low");
	});

	it.each([
		{ provider: "faux", modelId: "gpt-6-astra" },
		{ provider: "openai-codex", modelId: "gpt-5.6" },
		{ provider: "openai", modelId: "gpt-6-astra-fast" },
	])("ignores configuration outside the native model scope: $provider/$modelId", async (options) => {
		// Given a model to which native configuration updates do not apply.
		const { manager, resume } = await fixture(options);
		const updatesBefore = manager.getEntries().filter((entry) => entry.type === "configuration_update");
		// When resumed.
		const session = await resume();
		// Then defaults still apply and no model-inapplicable reconciliation is appended.
		expect(session.thinkingLevel).toBe("low");
		expect(manager.getEntries().filter((entry) => entry.type === "configuration_update")).toEqual(updatesBefore);
	});
});
