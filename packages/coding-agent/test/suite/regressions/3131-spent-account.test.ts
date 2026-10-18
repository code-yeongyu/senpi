import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { describeUsageLimitMessage, usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";
import { createAssistantRenderDescriptors } from "../../../src/modes/interactive/components/assistant-render-descriptors.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

const accountLimit =
	'429 {"error":{"type":"rate_limit_error","message":"You have hit your session limit; resets 11pm"}}';
// Serialized records carry timestamps and ids whose digits can contain "429"; match the raw payload itself.
const rawAccountPayload = /429 \{|rate_limit_error/;

describe("#3131 spent account", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("ends after one account-limited request without scheduling backoff or trying siblings", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "primary" }, { id: "sibling" }],
			settings: {
				compaction: { enabled: false },
				retry: {
					enabled: true,
					maxRetries: 5,
					baseDelayMs: 2000,
					fallbackChains: { "faux/primary": ["faux/sibling"] },
				},
			},
			fallbackNow: () => Date.now(),
			retryRandom: () => 0,
		});
		harnesses.push(harness);
		vi.useFakeTimers();
		harness.setResponses(
			Array.from({ length: 10 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit }),
			),
		);

		// when
		const turn = harness.session.prompt("continue");
		await vi.runAllTimersAsync();
		await turn;

		// then
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary"]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		const published = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		if (published?.message.role !== "assistant") throw new Error("missing account failure message");
		expect(published.message).toMatchObject({
			errorCause: { type: "usage_limit", scope: "account" },
		});
		for (const part of ["faux", "resets 11pm", "/model", "retry.fallbackChains"]) {
			expect(published.message.errorMessage).toContain(part);
		}
		expect(published.message.errorMessage).not.toMatch(/429|rate_limit_error/);
		// The original provider payload stays available to engine diagnostics.
		expect(harness.session.state.messages.findLast((message) => message.role === "assistant")).toMatchObject({
			errorMessage: accountLimit,
		});
	});

	it.each(["manual", "pre-prompt", "builtin-manual", "builtin-pre-prompt"] as const)(
		"uses the held target for %s compaction without calling the spent provider",
		async (path) => {
			// given a spent account and a transcript whose target needs compaction
			const harness = await createHarness({
				models: [{ id: "primary", contextWindow: 1_000_000, maxTokens: 32_000 }],
				tools: [],
				settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: true } },
				extensionFactories: path.startsWith("builtin") ? [compactionExtension] : [],
				fallbackNow: () => 0,
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit })]);
			await harness.session.prompt("hit the account limit");
			const primary = harness.getModel();
			harness.modelRegistry.registerProvider("usable", {
				api: primary.api,
				apiKey: "faux-key",
				baseUrl: primary.baseUrl,
				models: [
					{
						id: "target",
						name: "Target",
						contextWindow: 372_000,
						maxTokens: 32_000,
						reasoning: false,
						input: ["text"],
						cost: primary.cost,
					},
				],
			});
			const target = harness.session.modelRuntime.getModel("usable", "target");
			if (!target) throw new Error("missing target fixture");
			for (const text of ["large live context ".repeat(30_000), "continue"]) {
				harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
				const response = fauxAssistantMessage("earlier response");
				harness.sessionManager.appendMessage({
					...response,
					provider: primary.provider,
					model: primary.id,
					usage: { ...response.usage, input: 320_000, totalTokens: 321_000 },
				});
			}
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			await harness.session.setModel(target);
			expect(harness.session.pendingModelSwitch?.model.id).toBe("target");
			const requests: string[] = [];
			harness.setResponses([
				(_context, _options, _state, model) => {
					requests.push(`${model.provider}/${model.id}`);
					return fauxAssistantMessage("a usable model summary");
				},
				(_context, _options, _state, model) => {
					requests.push(`${model.provider}/${model.id}`);
					return fauxAssistantMessage("continued on target");
				},
			]);

			// when
			if (path.endsWith("manual")) await harness.session.compact();
			else await harness.session.prompt("continue after switching");

			// then
			expect(requests[0]).toBe("usable/target");
			expect(requests).not.toContain("faux/primary");
			expect(harness.sessionManager.getEntries().findLast((entry) => entry.type === "compaction")).toMatchObject({
				summary: expect.stringContaining("a usable model summary"),
			});
			expect(harness.eventsOfType("resume_context_reduced")).toEqual([]);
			if (path.endsWith("pre-prompt")) {
				expect(harness.session.model?.provider).toBe("usable");
				expect(harness.session.pendingModelSwitch).toBeUndefined();
			}
		},
	);

	it.each([false, true])(
		"reports the account limit without a summary request when no usable model exists (builtin=%s)",
		async (builtin) => {
			// given
			const harness = await createHarness({
				models: [{ id: "primary" }],
				settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: true } },
				extensionFactories: builtin ? [compactionExtension] : [],
				fallbackNow: () => 0,
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit })]);
			await harness.session.prompt("use the account");
			for (const text of ["older turn", "recent turn"]) {
				harness.sessionManager.appendMessage({ role: "user", content: text.repeat(100), timestamp: 1 });
				harness.sessionManager.appendMessage(fauxAssistantMessage("earlier response".repeat(100)));
			}
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const callsBefore = harness.faux.getCallLog().length;
			// when
			await expect(harness.session.compact()).rejects.toThrow(
				"The faux account usage limit has been reached (resets 11pm).",
			);
			// then
			expect(harness.faux.getCallLog()).toHaveLength(callsBefore);
			expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain(
				"The faux account usage limit has been reached (resets 11pm). Switch to another provider with /model",
			);
		},
	);

	it("keeps trying a sibling model for a model-scoped usage limit", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "primary" }, { id: "sibling" }],
			settings: {
				compaction: { enabled: false },
				retry: { enabled: true, fallbackChains: { "faux/primary": ["faux/sibling"] } },
			},
		});
		harnesses.push(harness);
		vi.useFakeTimers();
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '429 {"type":"rate_limit_error","message":"You have hit your Fable weekly limit"}',
			}),
			fauxAssistantMessage("sibling answers"),
		]);
		// when
		const turn = harness.session.prompt("continue on another model");
		await vi.runAllTimersAsync();
		await turn;
		// then
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary", "sibling"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ limit: "model" }]);
	});

	it("answers on a configured spare account while skipping a sibling on the spent provider", async () => {
		const harness = await createHarness({
			models: [{ id: "primary" }, { id: "sibling" }, { id: "spare" }],
			settings: {
				compaction: { enabled: false },
				retry: { enabled: true, fallbackChains: { "faux/primary": ["faux/sibling", "spare/spare"] } },
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "spare", ["spare"]);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit }),
			fauxAssistantMessage("answered by spare"),
		]);
		await harness.session.prompt("use my configured spare");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary", "spare"]);
		expect(harness.session.model?.provider).toBe("spare");
		expect(harness.session.messages.at(-1)).toMatchObject({
			content: [expect.objectContaining({ text: "answered by spare" })],
		});
	});

	it.each([
		{ error: '429 {"error":{"message":"You have hit your session limit"}}', windowMs: 30_000 },
		{ error: "usage_limit_reached: the usage limit has been reached", windowMs: 30 * 60_000 },
		{
			error: `429 {"error":{"type":"usage_limit_reached","resets_at":${Date.UTC(2026, 9, 11, 0, 1) / 1000}}}`,
			windowMs: 60_000,
		},
	])("does not renew a spent window on local refusals ($windowMs ms)", async ({ error, windowMs }) => {
		let now = 0;
		const epoch = Date.UTC(2026, 9, 11);
		const harness = await createHarness({
			fallbackNow: () => now,
			fallbackWallNow: () => epoch + now,
			settings: { retry: { enabled: true }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: error }),
			fauxAssistantMessage("account reset"),
		]);
		await harness.session.prompt("first attempt");
		for (const elapsed of [windowMs / 2, windowMs - 1]) {
			now = elapsed;
			await expect(harness.session.prompt("still waiting")).rejects.toThrow();
			expect(harness.faux.getCallLog()).toHaveLength(1);
		}
		now = windowMs + 1;
		await harness.session.prompt("after the original reset");
		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			content: [expect.objectContaining({ text: "account reset" })],
		});
	});

	it("allows a deliberate manual model selection to probe an account again", async () => {
		const harness = await createHarness({
			models: [{ id: "primary" }, { id: "sibling" }],
			settings: { retry: { enabled: true }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit }),
			fauxAssistantMessage("manual probe answered"),
		]);
		await harness.session.prompt("spend the account");
		const sibling = harness.getModel("sibling");
		if (!sibling) throw new Error("missing sibling fixture");
		await harness.session.setModel(sibling);
		await harness.session.prompt("probe after my explicit switch");
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["primary", "sibling"]);
	});

	it("keeps builtin compaction on a healthy session model despite a core compaction override", async () => {
		const harness = await createHarness({
			models: [{ id: "primary" }, { id: "cheap" }],
			settings: { compaction: { keepRecentTokens: 1, model: "other/cheap" } },
			extensionFactories: [compactionExtension],
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other", ["cheap"]);
		for (const text of ["older turn", "recent turn"]) {
			harness.sessionManager.appendMessage({ role: "user", content: text.repeat(100), timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("prior answer".repeat(100)));
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const requests: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				requests.push(`${model.provider}/${model.id}`);
				return fauxAssistantMessage("healthy summary");
			},
		]);
		await harness.session.compact();
		expect(requests).toEqual(["faux/primary"]);
	});

	it("skips an authenticated summary alternate whose context window cannot fit the input", async () => {
		const harness = await createHarness({
			models: [
				{ id: "primary", contextWindow: 1_000_000 },
				{ id: "tiny", contextWindow: 1_000, maxTokens: 100 },
				{ id: "roomy", contextWindow: 128_000 },
			],
			settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: true } },
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "tiny", ["tiny"]);
		registerFallbackModels(harness, "roomy", ["roomy"]);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit })]);
		await harness.session.prompt("spend the account");
		for (const text of ["older turn", "recent turn"]) {
			harness.sessionManager.appendMessage({ role: "user", content: text.repeat(1000), timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("prior answer".repeat(100)));
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const requests: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				requests.push(`${model.provider}/${model.id}`);
				return fauxAssistantMessage("roomy summary");
			},
			(_context, _options, _state, model) => {
				requests.push(`${model.provider}/${model.id}`);
				return fauxAssistantMessage("roomy turn prefix");
			},
		]);
		await harness.session.compact();
		expect(requests).toEqual(["roomy/roomy", "roomy/roomy"]);
	});

	it("refuses another prompt on a remembered spent account before making a request", async () => {
		// given
		const harness = await createHarness({ settings: { retry: { enabled: true } }, fallbackNow: () => 0 });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit })]);
		await harness.session.prompt("first attempt");
		const callsBefore = harness.faux.getCallLog().length;
		// when
		await expect(harness.session.prompt("try again")).rejects.toThrow(
			"The faux account usage limit has been reached",
		);
		// then
		expect(harness.faux.getCallLog()).toHaveLength(callsBefore);
	});

	it("keeps model-scoped limit presentation unchanged between live and restored messages", () => {
		initTheme("dark");
		const raw = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "You've reached your Fable limit. Switch to another model.",
		});
		const published = describeUsageLimitMessage(raw);
		expect(published.errorCause).toEqual({ type: "usage_limit", scope: "model" });
		const renderOptions = {
			expanded: false,
			hiddenThinkingLabel: "",
			hideThinkingBlock: false,
			hasToolCalls: false,
		};
		expect(createAssistantRenderDescriptors(published, renderOptions)).toEqual(
			createAssistantRenderDescriptors(raw, renderOptions),
		);
	});

	it("prints and renders the limit advice without exposing raw provider JSON", async () => {
		// given a real session and print-mode runtime
		const harness = await createHarness({
			models: [{ id: "primary" }, { id: "sibling" }],
			settings: {
				retry: { enabled: true, fallbackChains: { "faux/primary": ["faux/sibling"] } },
				compaction: { enabled: false },
			},
		});
		harnesses.push(harness);
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.session.agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.modelRegistry,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("This fixture does not replace sessions");
			},
		);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: accountLimit })]);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		// when
		const exitCode = await runPrintMode(runtime, { mode: "text", initialMessage: "continue" });
		// then
		expect(exitCode).toBe(1);
		const output = stderr.mock.calls.flat().join("\n");
		expect(output).toContain("The faux account usage limit has been reached (resets 11pm).");
		expect(output).not.toContain("429");
		expect(output).not.toContain("rate_limit_error");
		const internal = harness.session.state.messages.findLast((message) => message.role === "assistant");
		if (internal?.role !== "assistant") throw new Error("missing assistant fixture");
		initTheme("dark");
		const restored = createAssistantRenderDescriptors(internal, {
			expanded: false,
			hiddenThinkingLabel: "",
			hideThinkingBlock: false,
			hasToolCalls: false,
		});
		expect(restored.find((descriptor) => descriptor.kind === "error-text")?.text).toContain(
			"The faux account usage limit has been reached (resets 11pm).",
		);
		expect(JSON.stringify(restored)).not.toContain("429");
		const published = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		if (published?.message.role !== "assistant") throw new Error("missing published assistant fixture");
		expect(usageLimitScope(published.message)).toBe("account");
		const live = createAssistantRenderDescriptors(published.message, {
			expanded: false,
			hiddenThinkingLabel: "",
			hideThinkingBlock: false,
			hasToolCalls: false,
		});
		expect(live).toEqual(restored);
		const records: Record<string, unknown>[] = [];
		const handler = createRpcConnectionHandler(runtime, {
			writeRaw(chunk) {
				for (const line of chunk.split("\n").filter(Boolean)) records.push(JSON.parse(line));
			},
			waitForBackpressure: async () => {},
		});
		try {
			await handler.ready;
			await handler.handleInputLine(JSON.stringify({ type: "get_messages", id: "history" }));
			const history = records.find((record) => record.id === "history");
			expect(history).toMatchObject({
				success: true,
				data: {
					messages: expect.arrayContaining([
						expect.objectContaining({ errorCause: { type: "usage_limit", scope: "account" } }),
					]),
				},
			});
			expect(JSON.stringify(history)).not.toMatch(rawAccountPayload);
			const appendedEntries = harness.eventsOfType("entry_appended");
			const unsubscribeEntries = harness.session.subscribe((event) => {
				if (event.type === "entry_appended") appendedEntries.push(event);
			});
			await harness.session.bindExtensions({ mode: "rpc" });
			const rawEntry = harness.sessionManager
				.getEntries()
				.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (rawEntry?.type !== "message") throw new Error("missing raw assistant entry");
			harness.session.appendSessionEntry({
				...rawEntry,
				id: "raw-account-copy",
				parentId: harness.sessionManager.getLeafId(),
			});
			unsubscribeEntries();
			const appended = appendedEntries.at(-1);
			expect(appended).toMatchObject({
				entry: { message: { errorCause: { type: "usage_limit", scope: "account" } } },
			});
			expect(JSON.stringify(appended)).not.toMatch(rawAccountPayload);
			for (const command of ["get_entries", "get_tree"]) {
				await handler.handleInputLine(JSON.stringify({ type: command, id: command }));
				const response = records.find((record) => record.id === command);
				expect(response).toMatchObject({ success: true });
				expect(JSON.stringify(response)).toContain('"scope":"account"');
				expect(JSON.stringify(response)).not.toMatch(rawAccountPayload);
			}
			expect(harness.sessionManager.getEntry("raw-account-copy")).toMatchObject({
				message: { errorMessage: accountLimit },
			});
		} finally {
			await handler.dispose();
		}
	});
});
