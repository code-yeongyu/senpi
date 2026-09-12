import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension, { getPromptContextWindow } from "../../src/core/extensions/builtin/compaction/index.ts";
import {
	computeEffectiveThreshold,
	resolveEffectiveReserveTokens,
} from "../../src/core/extensions/builtin/compaction/policy.ts";
import { resolveSpeculationLeadTokens } from "../../src/core/extensions/builtin/compaction/speculation-lead.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const WINDOWS = [200_000, 650_000, 1_000_000] as const;
const harnesses: Harness[] = [];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => (resolve = next));
	return { promise, resolve };
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function logEvents(harness: Harness): Array<{ event: string }> {
	const candidates = [
		join(harness.tempDir, "logs", "compaction.log"),
		join(harness.tempDir, "agent", "logs", "compaction.log"),
		...readdirSync(harness.tempDir, { recursive: true })
			.filter((entry): entry is string => typeof entry === "string" && entry.endsWith("compaction.log"))
			.map((entry) => join(harness.tempDir, entry)),
	];
	const path = candidates.find((candidate) => existsSync(candidate));
	try {
		if (!path) return [];
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function count(events: Array<{ event: string }>, event: string): number {
	return events.filter((entry) => entry.event === event).length;
}

async function runLongSession(
	contextWindow: number,
): Promise<{ harness: Harness; events: Array<{ event: string }>; contextEvents: number }> {
	let contextEvents = 0;
	const harness = await createHarness({
		models: [
			{
				id: `thrash-${contextWindow}`,
				contextWindow,
				maxTokens: contextWindow > 500_000 ? 384_000 : contextWindow > 300_000 ? 128_000 : 100_000,
			},
		],
		settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => compactionExtension(pi),
			(pi) =>
				pi.on("context", () => {
					contextEvents++;
				}),
		],
	});
	harnesses.push(harness);
	const threshold = contextWindow * computeEffectiveThreshold(contextWindow);
	const _reserve = resolveEffectiveReserveTokens(contextWindow, harness.settingsManager.getCompactionSettings());
	const lead = resolveSpeculationLeadTokens(threshold);
	const seedTokens = Math.floor(threshold - lead + 10_000);
	const seed = "long-session-context";
	const seedResponse = fauxAssistantMessage("seed response");
	seedResponse.usage = { ...seedResponse.usage, input: seedTokens, totalTokens: seedTokens };
	harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: seed }], timestamp: 1 });
	seedResponse.usage = { ...seedResponse.usage, input: seedTokens, totalTokens: seedTokens };
	harness.sessionManager.appendMessage({
		...seedResponse,
		api: harness.getModel().api,
		provider: harness.getModel().provider,
		model: harness.getModel().id,
	});
	for (let index = 0; index < 24; index++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `turn-${index}` }],
			timestamp: index + 2,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(`answer-${index}`),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

	const summary = deferred<ReturnType<typeof fauxAssistantMessage>>();
	harness.setResponses([() => summary.promise, fauxAssistantMessage("normal response")]);
	const runner = harness.getExtensionRunner();
	// Idle speculation is gated on a PERSISTENT extension mode (idle.ts: tui/rpc/app-server).
	// The suite harness leaves the runner at its "print" default, where agent_end can never
	// reach startSpeculativeCompaction - which made any invalidation bound vacuous. Pin a
	// real interactive mode so the speculative lifecycle actually runs.
	runner.setUIContext(undefined, "tui");
	if ((harness.session.getContextUsage()?.tokens ?? 0) < threshold - lead)
		throw new Error(`usage too low: ${harness.session.getContextUsage()?.tokens}`);
	const turn = runner.emit({ type: "agent_end", messages: [] });
	for (let churnTurn = 0; churnTurn < 36; churnTurn++) {
		for (let event = 0; event < 9; event++) await runner.emitContext([]);
	}
	// The churn above ran while a real speculative job was IN FLIGHT: the summary
	// deferred is still unresolved here, so a logged start means the job was live for
	// the whole churn. Without this, the invalidation bound is vacuous (0 <= 0 + 2
	// passes with no speculative lifecycle at all). Asserted BEFORE the event count so
	// a missing speculative lifecycle fails on its own cause, not on arithmetic.
	const midChurn = logEvents(harness);
	expect(count(midChurn, "speculative_started")).toBeGreaterThanOrEqual(1);
	// A storm would invalidate on every one of the 324 churn context events; the shipped
	// contract invalidates only on real lifecycle events.
	expect(count(midChurn, "speculative_invalidated")).toBeLessThanOrEqual(count(midChurn, "speculative_started") + 2);
	// ABSOLUTE lifecycle bounds. The relative bound above cannot see the incident's real
	// mechanism - a kill-and-RESTART loop increments both counters in lockstep, so it
	// satisfies `invalidated <= started + 2` by construction. Churn must not manufacture
	// speculative lifecycles at all: a healthy run starts one job and keeps it.
	expect(count(midChurn, "speculative_started")).toBeLessThanOrEqual(3);
	expect(count(midChurn, "speculative_invalidated")).toBeLessThanOrEqual(3);
	// 36x9 churn events plus exactly one context event from the in-flight speculative
	// summary request itself - that extra event only exists because a real speculative
	// job is running, so this count is itself part of the in-flight proof.
	expect(contextEvents).toBe(36 * 9 + 1);
	summary.resolve(fauxAssistantMessage("deterministic speculative summary"));
	await turn;
	await harness.session.prompt(`cross the threshold ${"prompt ".repeat(20_000)}`);
	const firstEntry = harness.sessionManager.getEntries()[0];
	if (!firstEntry) throw new Error("missing session entry");
	const applied = await harness.session.applyCompaction(
		{ summary: "real applied summary", firstKeptEntryId: firstEntry.id, tokensBefore: seedTokens },
		{ reason: "extension", expectedRevision: harness.session.getMessageRevision() },
	);
	if (!applied.applied) throw new Error(`compaction did not apply: ${applied.reason}`);

	if (!runner.isActive || !runner.hasHandlers("before_agent_start"))
		throw new Error("real compaction extension is inactive");
	const events = logEvents(harness);
	return { harness, events, contextEvents };
}

describe("production-shaped compaction thrash regression", () => {
	// The 36x9 churn through the real AgentSession/ExtensionRunner is the expensive part
	// (~35s standalone, several times that under full-suite worker contention). It runs on
	// the 200K window, whose geometry is the tightest (largest maxTokens share), and the
	// window-independent geometry contract is pinned separately for every shipped window
	// below - so coverage is unchanged while the wall clock stays sane.
	it("keeps counters bounded through real AgentSession and ExtensionRunner sequencing", {
		timeout: 180_000,
	}, async () => {
		const contextWindow = 200_000;
		const { harness, events, contextEvents } = await runLongSession(contextWindow);
		const reserve = resolveEffectiveReserveTokens(contextWindow, harness.settingsManager.getCompactionSettings());
		const thresholdTokens = contextWindow * computeEffectiveThreshold(contextWindow);
		const lead = resolveSpeculationLeadTokens(thresholdTokens);
		expect(count(events, "threshold_trigger") + count(events, "hard_limit_trigger")).toBeGreaterThanOrEqual(1);
		expect(count(events, "emergency_prune")).toBe(0);
		expect(count(events, "speculative_started")).toBeGreaterThanOrEqual(1);
		expect(count(events, "speculative_invalidated")).toBeLessThanOrEqual(count(events, "speculative_started") + 2);
		// Mirrored absolute bounds - see the mid-churn site: paired invalidate+restart
		// storms are invisible to the relative bound.
		expect(count(events, "speculative_started")).toBeLessThanOrEqual(3);
		expect(count(events, "speculative_invalidated")).toBeLessThanOrEqual(3);
		expect(thresholdTokens - lead).toBeLessThan(thresholdTokens);
		expect(thresholdTokens).toBeLessThan(contextWindow - reserve);
		expect(contextEvents).toBe(36 * 9 + 2);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("orders speculation, threshold and emergency points for every shipped window", async () => {
		for (const contextWindow of WINDOWS) {
			const harness = await createHarness({
				models: [{ id: `geometry-${contextWindow}`, contextWindow }],
				settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
				extensionFactories: [(pi) => compactionExtension(pi)],
			});
			harnesses.push(harness);
			const reserve = resolveEffectiveReserveTokens(contextWindow, harness.settingsManager.getCompactionSettings());
			const thresholdTokens = contextWindow * computeEffectiveThreshold(contextWindow);
			const lead = resolveSpeculationLeadTokens(thresholdTokens);
			expect(thresholdTokens - lead).toBeLessThan(thresholdTokens);
			expect(thresholdTokens).toBeLessThan(contextWindow - reserve);
		}
	});

	it("pins the shipped prompt geometry through observed harness configuration", () => {
		expect(getPromptContextWindow(200_000, 100_000)).toBe(100_000);
		expect(getPromptContextWindow(650_000, 128_000)).toBe(522_000);
		expect(getPromptContextWindow(1_000_000, 384_000)).toBe(616_000);
	});

	it("pins the output-adjusted emergency basis at the production context callsite", async () => {
		// Band scenario: 200K window with 100K maxTokens gives promptWindow = 100K.
		// A context payload estimating ~120K tokens sits ABOVE the shipped engage point
		// (0.95 * 100K = 95K) but BELOW the full-window engage point (0.95 * 200K = 190K).
		// Shipped code (index.ts context handler passing getPromptContextWindow(...)) MUST
		// emergency-prune here; mutating that callsite back to the full window makes this
		// payload look safe and flips this assertion RED.
		const contextWindow = 200_000;
		const harness = await createHarness({
			models: [{ id: `emergency-band-${contextWindow}`, contextWindow, maxTokens: 100_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [(pi) => compactionExtension(pi)],
		});
		harnesses.push(harness);
		const seedResponse = fauxAssistantMessage("band seed");
		seedResponse.usage = { ...seedResponse.usage, input: 10_000, totalTokens: 10_000 };
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "band seed" }],
			timestamp: 1,
		});
		harness.sessionManager.appendMessage({
			...seedResponse,
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		expect(harness.session.getContextUsage()?.contextWindow).toBe(contextWindow);
		// estimateTotalTokens scales with content length here, so size the payload
		// directly in the (95K, 190K) band and make it PRUNABLE (tool results are what
		// hardLimitEmergencyPrune can drop).
		// Non-text image blocks bypass the text-part admission cap and estimate at
		// ESTIMATED_IMAGE_CHARS (4800 chars -> 1200 tokens) each, so 100 images put the
		// payload at ~120K tokens - inside the (95K, 190K) band for 200K/100K geometry.
		const imageCount = 100;
		const bandMessages = [
			{
				role: "user" as const,
				content: [
					{ type: "text" as const, text: "band question" },
					...Array.from({ length: imageCount }, (_, i) => ({
						type: "image" as const,
						data: `data:image/png;base64,band-${i}`,
						mimeType: "image/png",
					})),
				],
				timestamp: 1,
			},
		];
		await harness.getExtensionRunner().emitContext(bandMessages);
		const events = logEvents(harness);
		expect(count(events, "emergency_prune")).toBeGreaterThanOrEqual(1);
	});
});
