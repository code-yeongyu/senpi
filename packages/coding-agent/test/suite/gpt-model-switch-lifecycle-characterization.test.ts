// allow: SIZE_OK — one table keeps six persisted lifecycle payload cells directly comparable.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../../../ai/src/api/anthropic-messages.ts";
import { streamSimple as streamCompletions } from "../../../ai/src/api/openai-completions.ts";
import { streamSimple as streamResponses } from "../../../ai/src/api/openai-responses.ts";
import { convertResponsesMessages } from "../../../ai/src/api/openai-responses-shared.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import gptApplyPatchExtension, {
	createApplyPatchTool,
} from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";
import { sanitizeOpenAIResponsesPayload } from "../../src/core/extensions/builtin/tool-pair-guard/sanitize-openai-responses-payload.ts";
import type { ExtensionAPI, SessionStartEvent } from "../../src/core/extensions/types.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness } from "./harness.ts";

type LifecycleApi = "anthropic-messages" | "openai-completions" | "openai-responses";

interface LifecycleRow {
	label: string;
	reason: SessionStartEvent["reason"];
	api: LifecycleApi;
	provider: string;
	modelId: string;
	expectedTools: string[];
	expectedApplyPatchVariant: "custom" | "function" | undefined;
	expectedHistory: string[];
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MIXED_HISTORY: Context["messages"] = [
	{ role: "user", content: "change both files", timestamp: 1 },
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_patch",
				name: "apply_patch",
				arguments: { input: "*** Begin Patch\n*** End Patch" },
			},
			{ type: "toolCall", id: "call_edit", name: "edit", arguments: { path: "b.ts", edits: [] } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-source",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "call_patch",
		toolName: "apply_patch",
		content: [{ type: "text", text: "patched" }],
		isError: false,
		timestamp: 3,
	},
	{
		role: "toolResult",
		toolCallId: "call_edit",
		toolName: "edit",
		content: [{ type: "text", text: "edited" }],
		isError: false,
		timestamp: 4,
	},
];

const LIFECYCLE_ROWS: LifecycleRow[] = [
	{
		label: "startup",
		reason: "startup",
		api: "openai-responses",
		provider: "openai",
		modelId: "gpt-5.5",
		expectedTools: ["read", "bash", "apply_patch"],
		expectedApplyPatchVariant: "custom",
		expectedHistory: [
			"custom_tool_call:apply_patch",
			"function_call:edit",
			"custom_tool_call_output:apply_patch",
			"function_call_output:call_edit",
		],
	},
	{
		label: "reload",
		reason: "reload",
		api: "openai-responses",
		provider: "openai",
		modelId: "gpt-5.5",
		expectedTools: ["read", "bash", "apply_patch"],
		expectedApplyPatchVariant: "custom",
		expectedHistory: [
			"custom_tool_call:apply_patch",
			"function_call:edit",
			"custom_tool_call_output:apply_patch",
			"function_call_output:call_edit",
		],
	},
	{
		label: "new",
		reason: "new",
		api: "anthropic-messages",
		provider: "anthropic",
		modelId: "claude-sonnet",
		expectedTools: ["read", "bash", "edit", "write"],
		expectedApplyPatchVariant: undefined,
		expectedHistory: ["tool_use:apply_patch", "tool_use:edit", "tool_result:call_patch", "tool_result:call_edit"],
	},
	{
		label: "resume",
		reason: "resume",
		api: "openai-completions",
		provider: "openai",
		modelId: "gpt-5.5",
		expectedTools: ["read", "bash", "apply_patch"],
		expectedApplyPatchVariant: "function",
		expectedHistory: ["tool_call:apply_patch", "tool_call:edit", "tool_result:call_patch", "tool_result:call_edit"],
	},
	{
		label: "fork",
		reason: "fork",
		api: "openai-responses",
		provider: "openai",
		modelId: "gpt-5.5",
		expectedTools: ["read", "bash", "apply_patch"],
		expectedApplyPatchVariant: "custom",
		expectedHistory: [
			"custom_tool_call:apply_patch",
			"function_call:edit",
			"custom_tool_call_output:apply_patch",
			"function_call_output:call_edit",
		],
	},
	{
		label: "imported-jsonl",
		// AgentSessionRuntime imports JSONL through the resume lifecycle.
		reason: "resume",
		api: "anthropic-messages",
		provider: "anthropic",
		modelId: "claude-sonnet",
		expectedTools: ["read", "bash", "edit", "write"],
		expectedApplyPatchVariant: undefined,
		expectedHistory: ["tool_use:apply_patch", "tool_use:edit", "tool_result:call_patch", "tool_result:call_edit"],
	},
];

function makeModel<TApi extends LifecycleApi>(api: TApi, provider: string, id: string): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function applyPatchCall(callId: string, input: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "apply_patch", arguments: { input } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-source",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function applyPatchResult(callId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "apply_patch",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 3,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function recordsAt(value: unknown, key: string): Record<string, unknown>[] {
	if (!isRecord(value) || !Array.isArray(value[key])) return [];
	return value[key].filter(isRecord);
}

function field(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === "string" ? record[key] : undefined;
}

async function capturePayload(
	api: LifecycleApi,
	provider: string,
	modelId: string,
	context: Context,
): Promise<unknown> {
	let payload: unknown;
	const onPayload = (candidate: unknown): never => {
		payload = candidate;
		throw new Error("payload captured before transport");
	};

	if (api === "openai-responses") {
		await streamResponses(makeModel(api, provider, modelId), context, {
			apiKey: "fake-api-key",
			onPayload,
		}).result();
	} else if (api === "openai-completions") {
		await streamCompletions(makeModel(api, provider, modelId), context, {
			apiKey: "fake-api-key",
			onPayload,
		}).result();
	} else {
		await streamAnthropic(makeModel(api, provider, modelId), context, {
			apiKey: "fake-api-key",
			onPayload,
		}).result();
	}

	if (payload === undefined) throw new Error(`No ${api} payload was captured`);
	return payload;
}

function toolNames(payload: unknown): string[] {
	return recordsAt(payload, "tools").flatMap((tool) => {
		const directName = field(tool, "name");
		if (directName) return [directName];
		const nestedFunction = tool.function;
		if (!isRecord(nestedFunction)) return [];
		const nestedName = field(nestedFunction, "name");
		return nestedName ? [nestedName] : [];
	});
}

function applyPatchVariant(payload: unknown): "custom" | "function" | undefined {
	for (const tool of recordsAt(payload, "tools")) {
		if (field(tool, "name") === "apply_patch") {
			return field(tool, "type") === "custom" ? "custom" : "function";
		}
		const nestedFunction = tool.function;
		if (isRecord(nestedFunction) && field(nestedFunction, "name") === "apply_patch") {
			return "function";
		}
	}
	return undefined;
}

function responsesHistory(payload: unknown): string[] {
	const relevantTypes = new Set([
		"custom_tool_call",
		"function_call",
		"custom_tool_call_output",
		"function_call_output",
	]);
	return recordsAt(payload, "input").flatMap((item) => {
		const type = field(item, "type");
		if (!type || !relevantTypes.has(type)) return [];
		const identity = field(item, "name") ?? field(item, "call_id");
		return identity ? [`${type}:${identity}`] : [];
	});
}

function anthropicHistory(payload: unknown): string[] {
	return recordsAt(payload, "messages").flatMap((message) =>
		recordsAt(message, "content").flatMap((item) => {
			const type = field(item, "type");
			if (type === "tool_use") {
				const name = field(item, "name");
				return name ? [`tool_use:${name}`] : [];
			}
			if (type === "tool_result") {
				const callId = field(item, "tool_use_id");
				return callId ? [`tool_result:${callId}`] : [];
			}
			return [];
		}),
	);
}

function completionsHistory(payload: unknown): string[] {
	return recordsAt(payload, "messages").flatMap((message) => {
		const calls = recordsAt(message, "tool_calls").flatMap((call) => {
			const nestedFunction = call.function;
			const name = isRecord(nestedFunction) ? field(nestedFunction, "name") : undefined;
			return name ? [`tool_call:${name}`] : [];
		});
		if (field(message, "role") !== "tool") return calls;
		const callId = field(message, "tool_call_id");
		return callId ? [...calls, `tool_result:${callId}`] : calls;
	});
}

function payloadHistory(payload: unknown, api: LifecycleApi): string[] {
	if (api === "openai-responses") return responsesHistory(payload);
	if (api === "openai-completions") return completionsHistory(payload);
	return anthropicHistory(payload);
}

function seedMixedHistory(manager: SessionManager): void {
	for (const message of structuredClone(MIXED_HISTORY)) {
		manager.appendMessage(message);
	}
}

async function createLifecycleRuntime(
	row: LifecycleRow,
	observedReasons: SessionStartEvent["reason"][],
	registerCleanup: (cleanup: () => Promise<void> | void) => void,
): Promise<{ runtime: AgentSessionRuntime; tempDir: string }> {
	const tempDir = join(tmpdir(), `pi-model-switch-${row.label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const faux = registerFauxProvider({
		api: row.api,
		provider: row.provider,
		models: [{ id: row.modelId }],
	});
	const model = faux.getModel();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory({ enabledBuiltinExtensions: ["gpt-apply-patch"] }),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(row.provider, {
							baseUrl: model.baseUrl,
							apiKey: "faux-key",
							api: row.api,
							models: [
								{
									id: model.id,
									name: model.name,
									api: row.api,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
								},
							],
						});
						pi.on("session_start", (event) => {
							observedReasons.push(event.reason);
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const initialManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
	seedMixedHistory(initialManager);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: initialManager,
	});
	registerCleanup(async () => {
		await runtime.dispose();
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});
	return { runtime, tempDir };
}

async function driveLifecycle(
	row: LifecycleRow,
	registerCleanup: (cleanup: () => Promise<void> | void) => void,
): Promise<{ session: AgentSession; observedReason: SessionStartEvent["reason"] | undefined }> {
	const observedReasons: SessionStartEvent["reason"][] = [];
	const { runtime, tempDir } = await createLifecycleRuntime(row, observedReasons, registerCleanup);
	await runtime.session.bindExtensions({ shutdownHandler: () => {} });

	if (row.label === "reload") {
		await runtime.session.reload();
	} else if (row.label === "new") {
		await runtime.newSession({ setup: async (manager) => seedMixedHistory(manager) });
		await runtime.session.bindExtensions({});
	} else if (row.label === "resume") {
		const resumeManager = SessionManager.create(tempDir, join(tempDir, "resume-sessions"));
		seedMixedHistory(resumeManager);
		const resumeFile = resumeManager.getSessionFile();
		if (!resumeFile) throw new Error("Resume fixture did not create a session file");
		await runtime.switchSession(resumeFile);
		await runtime.session.bindExtensions({});
	} else if (row.label === "fork") {
		const leafId = runtime.session.sessionManager.getLeafId();
		if (!leafId) throw new Error("Fork fixture has no leaf entry");
		await runtime.fork(leafId, { position: "at" });
		await runtime.session.bindExtensions({});
	} else if (row.label === "imported-jsonl") {
		const importRoot = join(tempDir, "import-source");
		mkdirSync(importRoot, { recursive: true });
		const importManager = SessionManager.create(importRoot, join(importRoot, "sessions"));
		seedMixedHistory(importManager);
		const importFile = importManager.getSessionFile();
		if (!importFile) throw new Error("Import fixture did not create a session file");
		await runtime.importFromJsonl(importFile, tempDir);
		await runtime.session.bindExtensions({});
	}

	return { session: runtime.session, observedReason: observedReasons.at(-1) };
}

describe("GPT model-switch lifecycle characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("s7 updates system-prompt tool guidance atomically with a mid-session switch", async () => {
		// Given
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "proxy",
			models: [{ id: "claude-sonnet" }, { id: "gpt-5.5" }],
			extensionFactories: [gptApplyPatchExtension, promptPresetExtension],
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const target = harness.getModel("gpt-5.5");
		if (!target) throw new Error("Missing gpt-5.5 model");

		// When
		await harness.session.setModel({ ...target, api: "openai-responses" });

		// Then: one switch updates the active toolset and the prompt guidance in the same turn.
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "apply_patch"]);
		expect(harness.session.systemPrompt).toContain("- apply_patch:");
		expect(harness.session.systemPrompt).not.toContain("- edit:");
		expect(harness.session.systemPrompt).not.toContain("- write:");

		// When: switching back to a non-GPT model.
		const anthropicTarget = harness.getModel("claude-sonnet");
		if (!anthropicTarget) throw new Error("Missing claude-sonnet model");
		await harness.session.setModel(anthropicTarget);

		// Then: guidance tracks the restored edit tools.
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		expect(harness.session.systemPrompt).toContain("- edit:");
		expect(harness.session.systemPrompt).not.toContain("- apply_patch:");
	});

	it("s8 emits model_select when only the API changes", async () => {
		// Mutation-proofed: suppressing the `api` comparison in
		// AgentSession._modelSelectionChangesContext makes this test fail because no
		// model_select emission and no tool/prompt refresh is observed
		// (mutated-FAIL log: task-4-atomicity/mutation-api-gate-fail.log).
		// Given
		const selectedApis: string[] = [];
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "proxy",
			models: [{ id: "gpt-5.5", contextWindow: 128_000 }],
			extensionFactories: [
				gptApplyPatchExtension,
				promptPresetExtension,
				(pi) => {
					pi.on("model_select", (event) => {
						selectedApis.push(event.model.api);
					});
				},
			],
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const initialModel = harness.session.model;
		if (!initialModel) throw new Error("Missing initial model");
		const initialRevision = harness.session.getMessageRevision();

		// When
		await harness.session.setModel({ ...initialModel, api: "openai-responses" });

		// Then: provider/id/contextWindow equality must not hide an API-only context change.
		expect(selectedApis).toEqual(["openai-responses"]);
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "apply_patch"]);
		expect(harness.session.systemPrompt).toContain("- apply_patch:");
		expect(harness.session.getMessageRevision()).toBeGreaterThan(initialRevision);
	});

	it("s9 omits compacted-away calls while retaining a target-valid apply_patch pair", () => {
		// Given
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "discarded request", timestamp: 1 });
		manager.appendMessage(applyPatchCall("call_discarded", "old"));
		manager.appendMessage(applyPatchResult("call_discarded"));
		const firstKeptEntryId = manager.appendMessage({ role: "user", content: "retained request", timestamp: 4 });
		manager.appendMessage(applyPatchCall("call_retained", "new"));
		manager.appendMessage(applyPatchResult("call_retained"));
		manager.appendCompaction("discarded apply_patch work summarized", firstKeptEntryId, 1_000);

		// When
		const context: Context = {
			messages: convertToLlm(manager.buildSessionContext().messages),
			tools: [createApplyPatchTool()],
		};
		const wireInput = convertResponsesMessages(
			makeModel("openai-responses", "openai", "gpt-5.5"),
			context,
			new Set(["openai"]),
		);
		const serialized = JSON.stringify(wireInput);

		// Then
		expect(serialized).not.toContain("call_discarded");
		expect(serialized).toContain("call_retained");
		expect(serialized).toContain("discarded apply_patch work summarized");
	});

	it("s10 captures the first serialized payload for every lifecycle reason and imported JSONL", async () => {
		const actual = [];
		for (const row of LIFECYCLE_ROWS) {
			// Given
			const { session, observedReason } = await driveLifecycle(row, (cleanup) => cleanups.push(cleanup));

			// When
			const context: Context = {
				systemPrompt: session.systemPrompt,
				messages: convertToLlm(session.messages),
				tools: session.agent.state.tools,
			};
			const payload = await capturePayload(row.api, row.provider, row.modelId, context);

			// Then
			actual.push({
				label: row.label,
				reason: observedReason,
				tools: toolNames(payload),
				applyPatchVariant: applyPatchVariant(payload),
				history: payloadHistory(payload, row.api),
			});
		}

		expect(actual).toEqual(
			LIFECYCLE_ROWS.map((row) => ({
				label: row.label,
				reason: row.reason,
				tools: row.expectedTools,
				applyPatchVariant: row.expectedApplyPatchVariant,
				history: row.expectedHistory,
			})),
		);
	});

	it("s11 preserves output-only deltas when previous_response_id is populated", () => {
		// Given
		const payload = {
			previous_response_id: "resp_1",
			input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
		};

		// When
		const sanitized = sanitizeOpenAIResponsesPayload(payload);

		// Then
		expect(sanitized).toBe(payload);
	});
});
