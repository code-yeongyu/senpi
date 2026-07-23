import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionRunner } from "../../../src/core/extensions/index.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../../../src/core/settings-manager.ts";
import type { InlineExtension } from "../../../src/index.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

function compactionEntryCount(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

function agentMessagesContaining(harness: Harness, text: string): number {
	return harness.session.messages.filter((message) => getMessageText(message).includes(text)).length;
}

interface ReloadedHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	events: AgentSessionEvent[];
}

/**
 * Rebuild the full SessionManager/AgentSession stack from the source harness's
 * persisted session file, mirroring a close/reopen cycle. Reloaded messages are
 * new object identities with no runtime position bookkeeping, exactly like a
 * process restart.
 */
async function reloadHarnessFromSessionFile(
	source: Harness,
	options: {
		settings?: Partial<Settings>;
		extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	} = {},
): Promise<ReloadedHarness> {
	const sessionFile = source.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected the source harness to persist its session file");
	const sessionManager = SessionManager.open(sessionFile);
	const settingsManager = SettingsManager.inMemory(options.settings);
	const model = source.getModel();
	const modelRegistry = await createInMemoryModelRegistry(source.authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: source.faux.api,
		models: source.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model,
			systemPrompt: "You are a test assistant.",
			tools: [],
		},
		convertToLlm,
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, source.tempDir)
		: undefined;
	const resourceLoader = createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: source.tempDir,
		agentDir: join(source.tempDir, "agent-reload"),
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		extensionRunnerRef,
	});
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
	return { session, sessionManager, events };
}

async function appendMidCompactionMessage(harness: Harness): Promise<void> {
	await harness.session.sendCustomMessage({
		customType: "mid-compaction-note",
		content: "arrived mid-compaction",
		display: true,
	});
}

describe("Regression: stale compaction generation after a revision change", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("rejects stale compaction when the session changes during extension preparation", async () => {
		const preparationStarted = createDeferred();
		const releasePreparation = createDeferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", async (event) => {
						preparationStarted.resolve();
						await releasePreparation.promise;
						return {
							compaction: {
								summary: "summary generated from a stale branch",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial assistant")]);
		await harness.session.prompt("initial prompt ".repeat(40));

		const compactPromise = harness.session.compact();
		await preparationStarted.promise;
		await appendMidCompactionMessage(harness);
		releasePreparation.resolve();

		await expect(compactPromise).rejects.toThrow();
		expect(compactionEntryCount(harness)).toBe(0);
		expect(agentMessagesContaining(harness, "arrived mid-compaction")).toBe(1);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted === true)).toHaveLength(0);
	});

	it("rejects stale compaction when the session changes during summary generation", async () => {
		const generationStarted = createDeferred();
		const releaseGeneration = createDeferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial assistant"),
			async () => {
				generationStarted.resolve();
				await releaseGeneration.promise;
				return fauxAssistantMessage("provider generated summary");
			},
		]);
		await harness.session.prompt("initial prompt ".repeat(40));

		const compactPromise = harness.session.compact();
		await generationStarted.promise;
		await appendMidCompactionMessage(harness);
		releaseGeneration.resolve();

		await expect(compactPromise).rejects.toThrow();
		expect(compactionEntryCount(harness)).toBe(0);
		expect(agentMessagesContaining(harness, "arrived mid-compaction")).toBe(1);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted === true)).toHaveLength(0);
	});

	it("keeps a delayed assistant message_end post-compaction despite its earlier payload timestamp", async () => {
		const assistantEndStarted = createDeferred();
		const releaseAssistantEnd = createDeferred();
		const payloadTimestamp = Date.now() - 10_000;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("message_end", async (event) => {
						if (
							event.message.role !== "assistant" ||
							!getMessageText(event.message).includes("delayed assistant payload")
						)
							return;
						assistantEndStarted.resolve();
						await releaseAssistantEnd.promise;
					});
					pi.on("session_before_compact", () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "subsequent admission must remain blocked",
					}));
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed pending persistence boundary" }],
			timestamp: payloadTimestamp - 1,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			{
				...fauxAssistantMessage("delayed assistant payload"),
				timestamp: payloadTimestamp,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1_200,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			fauxAssistantMessage("must not reach the next provider admission"),
		]);
		const delayedPrompt = harness.session.prompt("produce a delayed assistant");
		void delayedPrompt.catch(() => undefined);
		await assistantEndStarted.promise;
		const firstEntry = harness.sessionManager.getEntries()[0];
		if (!firstEntry) throw new Error("Expected a persisted entry before compaction");

		const applied = await harness.session.applyCompaction(
			{
				summary: "summary that fits the original context window",
				firstKeptEntryId: firstEntry.id,
				tokensBefore: 42,
			},
			{ reason: "extension" },
		);
		expect(applied).toEqual({ applied: true, reason: "ok" });
		expect(agentMessagesContaining(harness, "delayed assistant payload")).toBe(1);

		releaseAssistantEnd.resolve();
		await delayedPrompt;
		const branch = harness.sessionManager.getBranch();
		const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
		const delayedAssistantIndex = branch.findIndex(
			(entry) => entry.type === "message" && getMessageText(entry.message).includes("delayed assistant payload"),
		);
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		expect(delayedAssistantIndex).toBeGreaterThan(compactionIndex);
		const delayedAssistant = branch[delayedAssistantIndex];
		if (delayedAssistant?.type !== "message" || delayedAssistant.message.role !== "assistant") {
			throw new Error("Expected the delayed assistant entry after compaction");
		}
		expect(delayedAssistant.message.timestamp).toBe(payloadTimestamp);
		expect(new Date(branch[compactionIndex]!.timestamp).getTime()).toBeGreaterThan(payloadTimestamp);

		await expect(harness.session.prompt("subsequent admission")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
	});

	it("keeps a reloaded delayed assistant post-compaction without falling back to payload timestamps", async () => {
		const assistantEndStarted = createDeferred();
		const releaseAssistantEnd = createDeferred();
		const payloadTimestamp = Date.now() - 10_000;
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("message_end", async (event) => {
						if (
							event.message.role !== "assistant" ||
							!getMessageText(event.message).includes("delayed assistant payload")
						)
							return;
						assistantEndStarted.resolve();
						await releaseAssistantEnd.promise;
					});
					pi.on("session_before_compact", () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "post-reload admission must compact or block",
					}));
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed pending persistence boundary" }],
			timestamp: payloadTimestamp - 1,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			{
				...fauxAssistantMessage("delayed assistant payload"),
				timestamp: payloadTimestamp,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1_200,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			fauxAssistantMessage("reloaded session must not reach the provider"),
		]);
		const delayedPrompt = harness.session.prompt("produce a delayed assistant");
		void delayedPrompt.catch(() => undefined);
		await assistantEndStarted.promise;
		const firstEntry = harness.sessionManager.getEntries()[0];
		if (!firstEntry) throw new Error("Expected a persisted entry before compaction");

		const applied = await harness.session.applyCompaction(
			{
				summary: "summary that fits the original context window",
				firstKeptEntryId: firstEntry.id,
				tokensBefore: 42,
			},
			{ reason: "extension" },
		);
		expect(applied).toEqual({ applied: true, reason: "ok" });

		releaseAssistantEnd.resolve();
		await delayedPrompt;

		// Close the live session, then reopen the persisted file through a fresh
		// SessionManager/AgentSession stack, exactly like a process restart.
		harness.session.dispose();
		const reloaded = await reloadHarnessFromSessionFile(harness, {
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "post-reload admission must compact or block",
					}));
				},
			],
		});

		try {
			const branch = reloaded.sessionManager.getBranch();
			const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
			const delayedAssistantIndex = branch.findIndex(
				(entry) => entry.type === "message" && getMessageText(entry.message).includes("delayed assistant payload"),
			);
			expect(compactionIndex).toBeGreaterThanOrEqual(0);
			expect(delayedAssistantIndex).toBeGreaterThan(compactionIndex);
			const compactionEntry = branch[compactionIndex]!;
			const delayedAssistantEntry = branch[delayedAssistantIndex]!;
			if (delayedAssistantEntry.type !== "message" || delayedAssistantEntry.message.role !== "assistant") {
				throw new Error("Expected the delayed assistant entry after compaction");
			}
			// The persisted branch orders the assistant after the compaction entry even
			// though its provider-supplied payload timestamp is older.
			expect(delayedAssistantEntry.message.timestamp).toBe(payloadTimestamp);
			expect(new Date(compactionEntry.timestamp).getTime()).toBeGreaterThan(payloadTimestamp);

			// The reloaded context is still above threshold (usage 1200 > window 1000),
			// so the next admission must compact (cancelled here) or block entirely. It
			// must not classify the assistant as pre-compaction via the timestamp
			// fallback and wave the prompt through to the provider.
			const providerCallsBefore = harness.faux.state.callCount;
			await expect(reloaded.session.prompt("subsequent admission after reload")).rejects.toThrow(
				"Context remains above the compaction threshold because compaction did not complete",
			);
			expect(harness.faux.state.callCount).toBe(providerCallsBefore);
			expect(reloaded.events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		} finally {
			reloaded.session.dispose();
		}
	});
});
