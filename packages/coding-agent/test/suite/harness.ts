import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentOptions, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
	ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { makeTempDir, onTempCleanup } from "../../../../scripts/vitest-temp.ts";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner, ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { convertToLlmForTransport } from "../../src/core/messages.ts";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../../src/core/settings-manager.ts";
import type { InlineExtension, ResourceLoader } from "../../src/index.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

/** The latest result of `toolName` in the session transcript. */
export function getToolResult(harness: Harness, toolName: string): ToolResultMessage {
	const result = harness.session.messages.findLast(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	if (!result) throw new Error(`No ${toolName} tool result`);
	return result;
}

/** An extension UI context that does nothing, with `overrides` applied. */
export function createTestUiContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		...overrides,
	};
}

export interface HarnessOptions {
	models?: FauxModelDefinition[];
	api?: string;
	provider?: string;
	settings?: Partial<Settings>;
	systemPrompt?: string;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	extensionFlagValues?: Map<string, boolean | string>;
	withConfiguredAuth?: boolean;
	upstreamModelId?: string;
	serviceTier?: "auto" | "flex" | "priority" | "ultrafast";
	onPayload?: (payload: unknown) => void;
	prepareNextTurnWithContext?: AgentOptions["prepareNextTurnWithContext"];
	persistSession?: boolean;
	autoTitleSessions?: boolean;
	fallbackNow?: () => number;
	retryRandom?: () => number;
	transportImageBudget?: { budgetBytes: number; alwaysKeepNewest: number };
	modelsJson?: Record<string, unknown>;
	fileSettings?: boolean;
	settingsFileName?: "settings.json" | "settings.jsonc";
	settingsContent?: string;
	retryProfile?: import("@earendil-works/pi-ai/utils/retry-profile/types").RetryPolicyProfile;
	evalOnlyToolNames?: string[];
	/** Send the senpi#2093 environment-context message. Off by default so transcript-pinning tests stay exact. */
	environmentContext?: boolean;
	/** Build a sibling session on another harness's faux provider, agent dir, and model registry. */
	siblingOf?: Harness;
	/** With `siblingOf`: build a fresh model runtime instead of sharing it, as `/new` does in the CLI. */
	siblingFreshRuntime?: boolean;
	/** Session to continue, for example to test a resume. Default: a new in-memory session. */
	sessionManager?: SessionManager;
	/** Working directory tools and extensions see as `ctx.cwd`. Default: the harness temp dir. */
	cwd?: string;
}

export interface Harness {
	agent: Agent;
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	getExtensionRunner(): ExtensionRunner;
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
}

const cleanups = new Set<() => void>();
onTempCleanup(() => {
	for (const cleanup of [...cleanups].reverse()) cleanup();
});

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = makeTempDir(join(tmpdir(), "pi-suite-"));
	const sibling = options.siblingOf;
	const sharedRegistry = options.siblingFreshRuntime ? undefined : sibling?.modelRegistry;
	const fauxProvider: FauxProviderRegistration =
		sibling?.faux ??
		registerFauxProvider({
			api: options.api,
			provider: options.provider,
			models: options.models,
		});
	if (!sibling) fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager =
		options.sessionManager ??
		(options.persistSession ? SessionManager.create(tempDir, join(tempDir, "sessions")) : SessionManager.inMemory());
	const agentDir = sibling ? join(sibling.tempDir, "agent") : join(tempDir, "agent");
	if (options.fileSettings) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, options.settingsFileName ?? "settings.json"),
			options.settingsContent ?? JSON.stringify(options.settings ?? {}, null, 2),
		);
	}
	const settingsManager = options.fileSettings
		? SettingsManager.create(tempDir, agentDir)
		: SettingsManager.inMemory(options.settings);

	const authStorage = sibling?.authStorage ?? AuthStorage.inMemory();
	if (withConfiguredAuth && !sibling) {
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	const modelsPath = options.modelsJson === undefined ? undefined : join(tempDir, "models.json");
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	const modelRegistry =
		sharedRegistry ??
		(modelsPath
			? await createModelRegistry(authStorage, modelsPath)
			: await createInMemoryModelRegistry(authStorage));
	if (withConfiguredAuth && !sharedRegistry) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			...(options.retryProfile !== undefined ? { retryPolicy: options.retryProfile } : {}),
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				inputLimits: registeredModel.inputLimits,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
				upstreamModelId:
					registeredModel.id === model.id && options.upstreamModelId !== undefined
						? options.upstreamModelId
						: undefined,
				serviceTier:
					registeredModel.id === model.id && options.serviceTier !== undefined ? options.serviceTier : undefined,
			})),
		});
	}

	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		streamFn: streamSimple,
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
			tools: [],
		},
		convertToLlm: (messages: AgentMessage[]) =>
			convertToLlmForTransport(messages, {
				blockImages: settingsManager.getBlockImages(),
				...options.transportImageBudget,
			}),
		onPayload: async (payload) => {
			options.onPayload?.(payload);
			const runner = extensionRunnerRef.current;
			if (!runner?.isActive || !runner.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.isActive || !runner.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.isActive) return messages;
			return runner.emitContext(messages);
		},
		prepareNextTurnWithContext: options.prepareNextTurnWithContext,
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	if (extensionsResult && options.extensionFlagValues) {
		for (const [name, value] of options.extensionFlagValues) {
			extensionsResult.runtime.flagValues.set(name, value);
		}
	}
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: options.cwd ?? tempDir,
		agentDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		evalOnlyToolNames: options.evalOnlyToolNames,
		extensionRunnerRef,
		autoTitleSessions: options.autoTitleSessions,
		fallbackNow: options.fallbackNow,
		retryRandom: options.retryRandom ?? (() => 0.5),
		environmentContext: options.environmentContext ?? false,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	const cleanup = () => {
		if (!cleanups.delete(cleanup)) return;
		session.dispose();
		if (!sibling) fauxProvider.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	};
	cleanups.add(cleanup);
	return {
		agent,
		session,
		sessionManager,
		settingsManager,
		authStorage,
		modelRegistry,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		getExtensionRunner() {
			const runner = extensionRunnerRef.current;
			if (!runner) throw new Error("Extension runner was not initialized");
			return runner;
		},
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup,
	};
}
