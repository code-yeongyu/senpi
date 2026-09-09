import { join } from "node:path";
import { estimateContextTokens, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { projectModelUsabilityBudget } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("#1511 oversized resume admission", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("opens an oversized resumed session and reports required compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "resume", contextWindow: 100_000, maxTokens: 4_000 }],
			persistSession: true,
		});
		harnesses.push(harness);
		const sessionManager = harness.sessionManager;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "! ".repeat(95_000 * 2) }],
			timestamp: Date.now(),
		});

		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "resume-agent"),
			model: harness.getModel(),
			sessionManager,
		});
		const events: unknown[] = [];
		resumed.session.subscribe((event) => events.push(event));
		await resumed.session.bindExtensions({});

		expect(resumed.session.agent.state.messages).toHaveLength(1);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "resume_compaction_required",
				projection: expect.objectContaining({ usable: false, admission: "resume" }),
				notice: expect.stringContaining("compacting before the first prompt"),
			}),
		);
		resumed.session.dispose();
	});

	it("compacts before the first provider request after oversized admission", async () => {
		const harness = await createHarness({
			models: [{ id: "resume", contextWindow: 100_000, maxTokens: 4_000 }],
			settings: {
				compaction: { enabled: true, speculativeEnabled: false, idleCompactionEnabled: false, keepRecentTokens: 1 },
			},
			extensionFactories: [
				(pi) =>
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "restored context summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					})),
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored context ".repeat(16_000) }],
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
			timestamp: 2,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("restored answer", { timestamp: 3 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const projection = projectModelUsabilityBudget({
			model,
			systemPrompt: harness.session.agent.state.systemPrompt,
			tools: harness.session.agent.state.tools,
			liveContextTokens: 80_000,
			compaction: harness.settingsManager.getCompactionSettings(),
			includeSpeculationLead: false,
			admission: "resume",
		});
		expect(projection.usable).toBe(false);
		harness.session.admitResumeCompactionRequired(projection);
		harness.setResponses([fauxAssistantMessage("first answer")]);
		await harness.session.bindExtensions({});

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("compaction_end").some((event) => event.accepted === true)).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.faux.getCallLog().length).toBeGreaterThan(0);
		const providerCall = harness.faux.getCallLog().at(-1);
		if (!providerCall) throw new Error("expected a provider request after required compaction");
		expect(estimateContextTokens(providerCall.context).tokens).toBeLessThanOrEqual(
			model.contextWindow - model.maxTokens,
		);

		// The resume requirement is consumed by the successful compaction, rather
		// than recomputed from the live projection on every turn.
		const compactionsAfterResume = harness.eventsOfType("compaction_end").length;
		const noticesAfterResume = harness.eventsOfType("resume_compaction_required").length;
		harness.appendResponses([fauxAssistantMessage("second answer")]);
		await harness.session.prompt("second prompt");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(compactionsAfterResume);
		expect(harness.eventsOfType("resume_compaction_required")).toHaveLength(noticesAfterResume);
	});

	it("does not report compaction for a usable resumed session", async () => {
		const harness = await createHarness({
			models: [{ id: "resume", contextWindow: 100_000, maxTokens: 4_000 }],
		});
		harnesses.push(harness);
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "usable-agent"),
			model: harness.getModel(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		const events: unknown[] = [];
		resumed.session.subscribe((event) => events.push(event));
		await resumed.session.bindExtensions({});
		expect(events.some((event) => (event as { type?: string }).type === "resume_compaction_required")).toBe(false);
		resumed.session.dispose();
	});
});
