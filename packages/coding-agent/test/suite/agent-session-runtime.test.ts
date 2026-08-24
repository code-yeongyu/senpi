import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SESSION_TOOL_POLICY_ENTRY_TYPE } from "../../src/core/session-tool-policy.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			beforeCreateRuntime?: (input: Parameters<CreateAgentSessionRuntimeFactory>[0]) => Promise<void>;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			cwd?: string;
			includeExtensionFactory?: (input: Parameters<CreateAgentSessionRuntimeFactory>[0]) => boolean;
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const providerFactory: ExtensionFactory = (pi) => {
			pi.registerProvider(faux.getModel().provider, {
				baseUrl: faux.getModel().baseUrl,
				apiKey: "faux-key",
				api: faux.api,
				models: faux.models.map((registeredModel) => ({
					id: registeredModel.id,
					name: registeredModel.name,
					api: registeredModel.api,
					reasoning: registeredModel.reasoning,
					input: registeredModel.input,
					cost: registeredModel.cost,
					contextWindow: registeredModel.contextWindow,
					maxTokens: registeredModel.maxTokens,
				})),
			});
		};
		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async (input) => {
			await options?.beforeCreateRuntime?.(input);
			const { cwd, sessionManager, sessionStartEvent } = input;
			const extensionFactories = [providerFactory];
			if (options?.includeExtensionFactory?.(input) ?? true) {
				extensionFactories.push(extensionFactory);
			}
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
				resourceLoaderOptions: {
					...runtimeOptions.resourceLoaderOptions,
					extensionFactories,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	it("makes new-session setup metadata visible to session_start handlers", async () => {
		// Given
		const observedNames: Array<string | undefined> = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				observedNames.push(ctx.sessionManager.getSessionName());
			});
		});
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({});
		});

		// When
		await runtime.newSession({
			setup: async (sessionManager) => {
				sessionManager.appendSessionInfo("setup-visible");
			},
		});

		// Then
		expect(observedNames.at(-1)).toBe("setup-visible");
	});

	it("persists an initialized new session without an assistant message when requested", async () => {
		// Given
		const { runtime } = await createRuntimeForTest(() => {});

		// When
		await runtime.newSession({
			persistInitializedSession: true,
			setup: async (sessionManager) => {
				sessionManager.appendSessionInfo("empty retained side");
			},
		});

		// Then
		expect(runtime.session.sessionFile).toBeDefined();
		expect(existsSync(runtime.session.sessionFile!)).toBe(true);
		const ctx = runtime.session.createReplacedSessionContext();
		const listed = await ctx.listSessions();
		const inspected = ctx.inspectSession(runtime.session.sessionFile!);
		expect(listed.some((session) => session.path === runtime.session.sessionFile)).toBe(true);
		expect(inspected.entries.length).toBeGreaterThan(0);
	});

	it("exposes replacement-context setters for live model thinking and tools", async () => {
		// Given
		const { runtime, faux } = await createRuntimeForTest(() => {});
		const ctx = runtime.session.createReplacedSessionContext();

		// When
		const modelSet = await ctx.setSessionModel(faux.getModel("faux-2")!);
		ctx.setSessionThinkingLevel("off");
		ctx.setActiveTools([]);

		// Then
		expect(modelSet).toBe(true);
		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
		expect(runtime.session.getActiveToolNames()).toEqual([]);
	});

	it("keeps a persisted disabled tool policy after later activation attempts", async () => {
		// Given
		const { runtime } = await createRuntimeForTest((pi) => {
			pi.on("before_provider_request", (event) => ({
				...(event.payload as Record<string, unknown>),
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}));
		});
		let activeTools: string[] | undefined;
		let registeredRead: unknown;
		let preparedPayload: unknown;

		// When
		await runtime.newSession({
			sessionToolPolicy: {
				version: 1,
				tools: "disabled",
			},
			withSession: async (ctx) => {
				ctx.setActiveTools(["read"]);
				activeTools = runtime.session.getActiveToolNames();
				registeredRead = runtime.session.getRegisteredTool("read");
				const prepared = await runtime.session.extensionRunner.prepareProviderRequest([]);
				preparedPayload = await prepared.transformPayload({ messages: [] });
			},
		});

		// Then
		expect(activeTools).toEqual([]);
		expect(registeredRead).toBeUndefined();
		expect(preparedPayload).toEqual({ messages: [] });
		expect(
			runtime.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === SESSION_TOOL_POLICY_ENTRY_TYPE),
		).toBe(true);
	});

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("settles the active response before session replacement", async () => {
		let toolStarted!: () => void;
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Blocks until aborted",
				parameters: Type.Object({}),
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						toolStarted();
						signal?.addEventListener("abort", () =>
							resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						);
					}),
			});
		});

		await runtime.session.prompt("hello");
		const firstSessionFile = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const outgoingSession = runtime.session;
		const promptPromise = outgoingSession.prompt("start blocking tool");
		await toolStartedPromise;

		const switchResult = await runtime.switchSession(firstSessionFile);
		await promptPromise;

		expect(switchResult.cancelled).toBe(false);
		expect(runtime.session.sessionFile).toBe(firstSessionFile);
		// The outgoing session settled before replacement: the interrupted tool
		// call has a persisted tool result instead of dangling forever.
		const outgoingEntries = SessionManager.open(outgoingSession.sessionFile!)
			.getEntries()
			.filter((entry) => entry.type === "message");
		expect(outgoingEntries.map((entry) => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const configuredSessionDir = parse(secondSessionFile!).dir;
		const openSpy = vi.spyOn(SessionManager, "open");
		const switchResult = await runtime.switchSession(originalSessionFile!, {
			sessionDir: configuredSessionDir,
		});
		expect(switchResult.cancelled).toBe(false);
		expect(openSpy).toHaveBeenCalledWith(originalSessionFile!, configuredSessionDir, undefined);
		openSpy.mockRestore();
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("cancels resume when source activity starts during session_before_switch", async () => {
		// Given
		let releaseBeforeSwitch!: () => void;
		const beforeSwitchReleased = new Promise<void>((resolve) => {
			releaseBeforeSwitch = resolve;
		});
		let beforeSwitchStarted!: () => void;
		const beforeSwitchStartedPromise = new Promise<void>((resolve) => {
			beforeSwitchStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", async (event) => {
				if (event.reason !== "resume") return;
				beforeSwitchStarted();
				await beforeSwitchReleased;
			});
		});
		await runtime.session.prompt("hello");
		const sourceSessionId = runtime.session.sessionManager.getSessionId();
		const sourceLeafId = runtime.session.sessionManager.getLeafId();
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(target.getSessionFile()!, {
			expectedSessionId: target.getSessionId(),
			expectedSource: {
				sessionId: sourceSessionId,
				leafId: sourceLeafId,
				wasIdle: true,
				activityGeneration: runtime.session.sourceActivityGeneration,
			},
		} as Parameters<typeof runtime.switchSession>[1] & {
			expectedSource: {
				sessionId: string;
				leafId: string | null;
				wasIdle: boolean;
				activityGeneration: number;
			};
		});
		await beforeSwitchStartedPromise;
		let unsubscribeAgentStart = () => {};
		const agentStarted = new Promise<void>((resolve) => {
			unsubscribeAgentStart = runtime.session.subscribe((event) => {
				if (event.type !== "agent_start") return;
				unsubscribeAgentStart();
				resolve();
			});
		});
		const newerTurn = runtime.session.prompt("newer turn");
		await agentStarted;
		expect(runtime.session.isIdle).toBe(false);
		releaseBeforeSwitch();
		const result = await switchPromise;
		void newerTurn;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getSessionId()).toBe(sourceSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("cancels new session when source activity starts during session_before_switch", async () => {
		// Given
		let releaseBeforeSwitch!: () => void;
		const beforeSwitchReleased = new Promise<void>((resolve) => {
			releaseBeforeSwitch = resolve;
		});
		let beforeSwitchStarted!: () => void;
		const beforeSwitchStartedPromise = new Promise<void>((resolve) => {
			beforeSwitchStarted = resolve;
		});
		const { runtime } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", async (event) => {
				if (event.reason !== "new") return;
				beforeSwitchStarted();
				await beforeSwitchReleased;
			});
		});
		await runtime.session.prompt("hello");
		const parentSession = runtime.session.sessionFile!;
		const sourceSessionId = runtime.session.sessionManager.getSessionId();
		const sourceLeafId = runtime.session.sessionManager.getLeafId();

		// When
		const newSessionPromise = runtime.newSession({
			expectedParentSessionId: sourceSessionId,
			expectedSource: {
				sessionId: sourceSessionId,
				leafId: sourceLeafId,
				wasIdle: true,
				activityGeneration: runtime.session.sourceActivityGeneration,
			},
			parentSession,
		} as Parameters<typeof runtime.newSession>[0] & {
			expectedSource: {
				sessionId: string;
				leafId: string | null;
				wasIdle: boolean;
				activityGeneration: number;
			};
		});
		await beforeSwitchStartedPromise;
		let unsubscribeAgentStart = () => {};
		const agentStarted = new Promise<void>((resolve) => {
			unsubscribeAgentStart = runtime.session.subscribe((event) => {
				if (event.type !== "agent_start") return;
				unsubscribeAgentStart();
				resolve();
			});
		});
		const newerTurn = runtime.session.prompt("newer turn");
		await agentStarted;
		expect(runtime.session.isIdle).toBe(false);
		releaseBeforeSwitch();
		const result = await newSessionPromise;
		void newerTurn;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getSessionId()).toBe(sourceSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("allows a guarded switch that was requested while the source was already streaming", async () => {
		// Given
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		let unsubscribeAgentStart = () => {};
		const agentStarted = new Promise<void>((resolve) => {
			unsubscribeAgentStart = runtime.session.subscribe((event) => {
				if (event.type !== "agent_start") return;
				unsubscribeAgentStart();
				resolve();
			});
		});
		const activeTurn = runtime.session.prompt("streaming turn");
		await agentStarted;
		const expectedSource = {
			sessionId: runtime.session.sessionManager.getSessionId(),
			leafId: runtime.session.sessionManager.getLeafId(),
			wasIdle: false,
			activityGeneration: runtime.session.sourceActivityGeneration,
		};
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();

		// When
		const result = await runtime.switchSession(target.getSessionFile()!, {
			expectedSessionId: target.getSessionId(),
			expectedSource,
		} as Parameters<typeof runtime.switchSession>[1] & {
			expectedSource: {
				sessionId: string;
				leafId: string | null;
				wasIdle: boolean;
				activityGeneration: number;
			};
		});
		void activeTurn;

		// Then
		expect(result).toEqual({ cancelled: false });
		expect(runtime.session.sessionManager.getSessionId()).toBe(target.getSessionId());
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("cancels a streaming-origin switch when a later user message appears during the veto", async () => {
		// Given
		let releaseBeforeSwitch!: () => void;
		const beforeSwitchReleased = new Promise<void>((resolve) => {
			releaseBeforeSwitch = resolve;
		});
		let beforeSwitchStarted!: () => void;
		const beforeSwitchStartedPromise = new Promise<void>((resolve) => {
			beforeSwitchStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", async (event) => {
				if (event.reason !== "resume") return;
				beforeSwitchStarted();
				await beforeSwitchReleased;
			});
		});
		let unsubscribeAgentStart = () => {};
		const agentStarted = new Promise<void>((resolve) => {
			unsubscribeAgentStart = runtime.session.subscribe((event) => {
				if (event.type !== "agent_start") return;
				unsubscribeAgentStart();
				resolve();
			});
		});
		const activeTurn = runtime.session.prompt("streaming turn");
		await agentStarted;
		const sourceSessionId = runtime.session.sessionManager.getSessionId();
		const expectedSource = {
			sessionId: sourceSessionId,
			leafId: runtime.session.sessionManager.getLeafId(),
			wasIdle: false,
			activityGeneration: (
				runtime.session as unknown as {
					sourceActivityGeneration: number;
				}
			).sourceActivityGeneration,
		};
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(target.getSessionFile()!, {
			expectedSessionId: target.getSessionId(),
			expectedSource,
		} as Parameters<typeof runtime.switchSession>[1] & {
			expectedSource: {
				sessionId: string;
				leafId: string | null;
				wasIdle: boolean;
				activityGeneration: number;
			};
		});
		await beforeSwitchStartedPromise;
		const laterTurn = runtime.session.prompt("later turn", { streamingBehavior: "followUp" });
		releaseBeforeSwitch();
		const result = await switchPromise;
		void activeTurn;
		void laterTurn;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getSessionId()).toBe(sourceSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("blocks new source prompts once guarded teardown begins", async () => {
		// Given
		let releaseShutdown!: () => void;
		const shutdownReleased = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		let shutdownStarted!: () => void;
		const shutdownStartedPromise = new Promise<void>((resolve) => {
			shutdownStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_shutdown", async (event) => {
				if (event.reason !== "resume") return;
				shutdownStarted();
				await shutdownReleased;
			});
		});
		await runtime.session.prompt("hello");
		const expectedSource = {
			sessionId: runtime.session.sessionManager.getSessionId(),
			leafId: runtime.session.sessionManager.getLeafId(),
			wasIdle: true,
			activityGeneration: runtime.session.sourceActivityGeneration,
		};
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		const switchPromise = runtime.switchSession(target.getSessionFile()!, {
			expectedSessionId: target.getSessionId(),
			expectedSource,
		} as Parameters<typeof runtime.switchSession>[1] & {
			expectedSource: {
				sessionId: string;
				leafId: string | null;
				wasIdle: boolean;
				activityGeneration: number;
			};
		});
		await shutdownStartedPromise;

		// When / Then
		try {
			expect((runtime.session as unknown as { isReplacementPending?: boolean }).isReplacementPending).toBe(true);
			await expect(runtime.session.prompt("late turn")).rejects.toThrow("Session replacement is in progress");
		} finally {
			releaseShutdown();
			await switchPromise;
		}
	});

	it("rejects a target replaced while session_before_switch is pending", async () => {
		// Given
		let releaseBeforeSwitch!: () => void;
		const beforeSwitchReleased = new Promise<void>((resolve) => {
			releaseBeforeSwitch = resolve;
		});
		let beforeSwitchStarted!: () => void;
		const beforeSwitchStartedPromise = new Promise<void>((resolve) => {
			beforeSwitchStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", async (event) => {
				if (event.reason !== "resume") return;
				beforeSwitchStarted();
				await beforeSwitchReleased;
			});
		});
		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		const targetSessionFile = target.getSessionFile()!;
		const expectedSessionId = target.getSessionId();
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(targetSessionFile, {
			expectedSessionId,
		} as Parameters<typeof runtime.switchSession>[1] & { expectedSessionId: string });
		await beforeSwitchStartedPromise;
		copyFileSync(replacement.getSessionFile()!, targetSessionFile);
		releaseBeforeSwitch();
		const result = await switchPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("rejects the current session replaced while a new-session veto is pending", async () => {
		// Given
		let releaseBeforeSwitch!: () => void;
		const beforeSwitchReleased = new Promise<void>((resolve) => {
			releaseBeforeSwitch = resolve;
		});
		let beforeSwitchStarted!: () => void;
		const beforeSwitchStartedPromise = new Promise<void>((resolve) => {
			beforeSwitchStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", async (event) => {
				if (event.reason !== "new") return;
				beforeSwitchStarted();
				await beforeSwitchReleased;
			});
		});
		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile!;
		const expectedCurrentSessionId = runtime.session.sessionManager.getSessionId();
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const newSessionPromise = runtime.newSession({
			expectedParentSessionId: expectedCurrentSessionId,
			parentSession: originalSessionFile,
		});
		await beforeSwitchStartedPromise;
		copyFileSync(replacement.getSessionFile()!, originalSessionFile);
		releaseBeforeSwitch();
		const result = await newSessionPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("uses header-only metadata for expected parent identity checks", async () => {
		// Given
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const parentSession = runtime.session.sessionFile!;
		const expectedParentSessionId = runtime.session.sessionManager.getSessionId();
		const inspectMetadata = vi.spyOn(SessionManager, "inspectMetadata");
		const open = vi.spyOn(SessionManager, "open");

		try {
			// When
			const result = await runtime.newSession({
				expectedParentSessionId,
				parentSession,
			});

			// Then
			expect(result).toEqual({ cancelled: false });
			expect(inspectMetadata).toHaveBeenCalledWith(parentSession);
			expect(open).not.toHaveBeenCalled();
		} finally {
			inspectMetadata.mockRestore();
			open.mockRestore();
		}
	});

	it("rebinds a live runtime when the parent is replaced during new-session shutdown", async () => {
		// Given
		let releaseShutdown!: () => void;
		const shutdownReleased = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		let shutdownStarted!: () => void;
		const shutdownStartedPromise = new Promise<void>((resolve) => {
			shutdownStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_shutdown", async (event) => {
				if (event.reason !== "new") return;
				shutdownStarted();
				await shutdownReleased;
			});
		});
		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile!;
		const expectedParentSessionId = runtime.session.sessionManager.getSessionId();
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const newSessionPromise = runtime.newSession({
			expectedParentSessionId,
			parentSession: originalSessionFile,
		});
		await shutdownStartedPromise;
		copyFileSync(replacement.getSessionFile()!, originalSessionFile);
		releaseShutdown();
		const result = await newSessionPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.extensionRunner.isActive).toBe(true);
		expect(runtime.session.sessionManager.getSessionId()).toBe(expectedParentSessionId);
		expect(runtime.session.messages.some((message) => message.role === "assistant")).toBe(true);
	});

	it("rejects a parent replaced during new-session runtime construction", async () => {
		// Given
		let shutdownCount = 0;
		let releaseConstruction!: () => void;
		const constructionReleased = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		let constructionBegan!: () => void;
		const constructionBeganPromise = new Promise<void>((resolve) => {
			constructionBegan = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_shutdown", () => {
					shutdownCount++;
				});
			},
			{
				beforeCreateRuntime: async (input) => {
					if (input.sessionStartEvent?.reason !== "new") return;
					constructionBegan();
					await constructionReleased;
				},
			},
		);
		await runtime.session.prompt("hello");
		const parentSession = runtime.session.sessionFile!;
		const expectedParentSessionId = runtime.session.sessionManager.getSessionId();
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const newSessionPromise = runtime.newSession({
			expectedParentSessionId,
			parentSession,
		});
		await constructionBeganPromise;
		copyFileSync(replacement.getSessionFile()!, parentSession);
		releaseConstruction();
		const result = await newSessionPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getSessionId()).toBe(expectedParentSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
		expect(shutdownCount).toBe(2);
	});

	it("rejects a parent replaced during new-session removed-extension handlers", async () => {
		// Given
		let releaseRemovedHandlers!: () => void;
		const removedHandlersReleased = new Promise<void>((resolve) => {
			releaseRemovedHandlers = resolve;
		});
		let removedHandlersStarted!: () => void;
		const removedHandlersStartedPromise = new Promise<void>((resolve) => {
			removedHandlersStarted = resolve;
		});
		let outgoingSessionId: string | undefined;
		const { runtime, tempDir } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_extensions_removed", async () => {
					removedHandlersStarted();
					await removedHandlersReleased;
				});
			},
			{
				includeExtensionFactory: (input) =>
					outgoingSessionId === undefined || input.sessionManager.getSessionId() === outgoingSessionId,
			},
		);
		await runtime.session.prompt("hello");
		const parentSession = runtime.session.sessionFile!;
		outgoingSessionId = runtime.session.sessionManager.getSessionId();
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const newSessionPromise = runtime.newSession({
			expectedParentSessionId: outgoingSessionId,
			parentSession,
		});
		await removedHandlersStartedPromise;
		copyFileSync(replacement.getSessionFile()!, parentSession);
		releaseRemovedHandlers();
		const result = await newSessionPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getSessionId()).toBe(outgoingSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("rejects a parent replaced during host rebind before the new-session callback", async () => {
		// Given
		let releaseRebind!: () => void;
		const rebindReleased = new Promise<void>((resolve) => {
			releaseRebind = resolve;
		});
		let rebindStarted!: () => void;
		const rebindStartedPromise = new Promise<void>((resolve) => {
			rebindStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const parentSession = runtime.session.sessionFile!;
		const outgoingSessionId = runtime.session.sessionManager.getSessionId();
		let createdSessionFile: string | undefined;
		const withSession = vi.fn();
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({});
			if (session.sessionManager.getSessionId() === outgoingSessionId) return;
			rebindStarted();
			await rebindReleased;
		});
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const newSessionPromise = runtime.newSession({
			expectedParentSessionId: outgoingSessionId,
			parentSession,
			persistInitializedSession: true,
			setup: async (sessionManager) => {
				createdSessionFile = sessionManager.getSessionFile();
			},
			withSession,
		});
		await rebindStartedPromise;
		copyFileSync(replacement.getSessionFile()!, parentSession);
		releaseRebind();
		const result = await newSessionPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(withSession).not.toHaveBeenCalled();
		expect(createdSessionFile).toBeDefined();
		expect(existsSync(createdSessionFile!)).toBe(false);
		expect(runtime.session.sessionManager.getSessionId()).toBe(outgoingSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("rejects a switch target replaced while session_shutdown is pending", async () => {
		// Given
		let releaseShutdown!: () => void;
		const shutdownReleased = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		let shutdownStarted!: () => void;
		const shutdownStartedPromise = new Promise<void>((resolve) => {
			shutdownStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_shutdown", async (event) => {
				if (event.reason !== "resume") return;
				shutdownStarted();
				await shutdownReleased;
			});
		});
		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		const targetSessionFile = target.getSessionFile()!;
		const expectedSessionId = target.getSessionId();
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(targetSessionFile, { expectedSessionId });
		await shutdownStartedPromise;
		copyFileSync(replacement.getSessionFile()!, targetSessionFile);
		releaseShutdown();
		const result = await switchPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("rejects a switch target replaced during runtime construction", async () => {
		// Given
		let shutdownCount = 0;
		let releaseSessionStart!: () => void;
		const sessionStartReleased = new Promise<void>((resolve) => {
			releaseSessionStart = resolve;
		});
		let sessionStartBegan!: () => void;
		const sessionStartBeganPromise = new Promise<void>((resolve) => {
			sessionStartBegan = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_shutdown", () => {
					shutdownCount++;
				});
			},
			{
				beforeCreateRuntime: async (input) => {
					if (input.sessionStartEvent?.reason !== "resume") return;
					sessionStartBegan();
					await sessionStartReleased;
				},
			},
		);
		await runtime.session.prompt("hello");
		const outgoingSessionId = runtime.session.sessionManager.getSessionId();
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		const targetSessionFile = target.getSessionFile()!;
		const expectedSessionId = target.getSessionId();
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(targetSessionFile, { expectedSessionId });
		await sessionStartBeganPromise;
		copyFileSync(replacement.getSessionFile()!, targetSessionFile);
		releaseSessionStart();
		const result = await switchPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getSessionId()).toBe(outgoingSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
		expect(shutdownCount).toBe(2);
	});

	it("rejects a switch target replaced during removed-extension handlers", async () => {
		// Given
		let releaseRemovedHandlers!: () => void;
		const removedHandlersReleased = new Promise<void>((resolve) => {
			releaseRemovedHandlers = resolve;
		});
		let removedHandlersStarted!: () => void;
		const removedHandlersStartedPromise = new Promise<void>((resolve) => {
			removedHandlersStarted = resolve;
		});
		let outgoingSessionId: string | undefined;
		const { runtime, tempDir } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_extensions_removed", async () => {
					removedHandlersStarted();
					await removedHandlersReleased;
				});
			},
			{
				includeExtensionFactory: (input) =>
					outgoingSessionId === undefined || input.sessionManager.getSessionId() === outgoingSessionId,
			},
		);
		await runtime.session.prompt("hello");
		outgoingSessionId = runtime.session.sessionManager.getSessionId();
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		const targetSessionFile = target.getSessionFile()!;
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(targetSessionFile, {
			expectedSessionId: target.getSessionId(),
		});
		await removedHandlersStartedPromise;
		copyFileSync(replacement.getSessionFile()!, targetSessionFile);
		releaseRemovedHandlers();
		const result = await switchPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getSessionId()).toBe(outgoingSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("rejects a switch target replaced during host rebind before the replacement callback", async () => {
		// Given
		let releaseRebind!: () => void;
		const rebindReleased = new Promise<void>((resolve) => {
			releaseRebind = resolve;
		});
		let rebindStarted!: () => void;
		const rebindStartedPromise = new Promise<void>((resolve) => {
			rebindStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const outgoingSessionId = runtime.session.sessionManager.getSessionId();
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		const targetSessionFile = target.getSessionFile()!;
		const withSession = vi.fn();
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({});
			if (session.sessionManager.getSessionId() !== target.getSessionId()) return;
			rebindStarted();
			await rebindReleased;
		});
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(targetSessionFile, {
			expectedSessionId: target.getSessionId(),
			withSession,
		});
		await rebindStartedPromise;
		copyFileSync(replacement.getSessionFile()!, targetSessionFile);
		releaseRebind();
		const result = await switchPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(withSession).not.toHaveBeenCalled();
		expect(runtime.session.sessionManager.getSessionId()).toBe(outgoingSessionId);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("keeps a replacement prompt-locked through host rebind and callback completion", async () => {
		// Given
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({});
			expect(session.isReplacementPending).toBe(true);
			await expect(session.prompt("early external prompt")).rejects.toThrow("Session replacement is in progress");
		});
		const withSession = vi.fn(async () => {
			expect(runtime.session.isReplacementPending).toBe(true);
		});

		// When
		const result = await runtime.switchSession(target.getSessionFile()!, {
			expectedSessionId: target.getSessionId(),
			withSession,
		});

		// Then
		expect(result).toEqual({ cancelled: false });
		expect(withSession).toHaveBeenCalledOnce();
		expect(runtime.session.isReplacementPending).toBe(false);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("retains the effective cwd when recovering a cancelled switch", async () => {
		// Given
		let releaseShutdown!: () => void;
		const shutdownReleased = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		let shutdownStarted!: () => void;
		const shutdownStartedPromise = new Promise<void>((resolve) => {
			shutdownStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_shutdown", async (event) => {
				if (event.reason !== "resume") return;
				shutdownStarted();
				await shutdownReleased;
			});
		});
		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile!;
		const effectiveCwd = runtime.session.sessionManager.getCwd();
		const lines = readFileSync(originalSessionFile, "utf8").split("\n");
		const header = JSON.parse(lines[0]!) as Record<string, unknown>;
		header.cwd = join(tempDir, "missing-original-cwd");
		lines[0] = JSON.stringify(header);
		writeFileSync(originalSessionFile, lines.join("\n"));
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		const targetSessionFile = target.getSessionFile()!;
		const expectedSessionId = target.getSessionId();
		const replacement = SessionManager.create(tempDir);
		replacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "replacement" }],
			timestamp: Date.now(),
		});
		replacement.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(targetSessionFile, { expectedSessionId });
		await shutdownStartedPromise;
		copyFileSync(replacement.getSessionFile()!, targetSessionFile);
		releaseShutdown();
		const result = await switchPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getCwd()).toBe(effectiveCwd);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
	});

	it("falls back to the detached snapshot when recovery path changes during construction", async () => {
		// Given
		let releaseShutdown!: () => void;
		const shutdownReleased = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		let shutdownStarted!: () => void;
		const shutdownStartedPromise = new Promise<void>((resolve) => {
			shutdownStarted = resolve;
		});
		let releaseRecovery!: () => void;
		const recoveryReleased = new Promise<void>((resolve) => {
			releaseRecovery = resolve;
		});
		let recoveryStarted!: () => void;
		const recoveryStartedPromise = new Promise<void>((resolve) => {
			recoveryStarted = resolve;
		});
		let outgoingSessionId: string | undefined;
		let blockRecovery = true;
		let shutdownCount = 0;
		const { runtime, tempDir } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_shutdown", async (event) => {
					shutdownCount++;
					if (event.reason !== "resume" || shutdownCount !== 1) return;
					shutdownStarted();
					await shutdownReleased;
				});
			},
			{
				beforeCreateRuntime: async (input) => {
					if (
						!blockRecovery ||
						input.sessionStartEvent?.reason !== "resume" ||
						input.sessionManager.getSessionId() !== outgoingSessionId
					) {
						return;
					}
					blockRecovery = false;
					recoveryStarted();
					await recoveryReleased;
				},
			},
		);
		await runtime.session.prompt("hello");
		const outgoingSessionFile = runtime.session.sessionFile!;
		outgoingSessionId = runtime.session.sessionManager.getSessionId();
		const target = SessionManager.create(tempDir);
		target.appendMessage({ role: "user", content: [{ type: "text", text: "target" }], timestamp: Date.now() });
		target.persistInitializedSession();
		const targetSessionFile = target.getSessionFile()!;
		const targetReplacement = SessionManager.create(tempDir);
		targetReplacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "target replacement" }],
			timestamp: Date.now(),
		});
		targetReplacement.persistInitializedSession();
		const outgoingReplacement = SessionManager.create(tempDir);
		outgoingReplacement.appendMessage({
			role: "user",
			content: [{ type: "text", text: "outgoing replacement" }],
			timestamp: Date.now(),
		});
		outgoingReplacement.persistInitializedSession();

		// When
		const switchPromise = runtime.switchSession(targetSessionFile, {
			expectedSessionId: target.getSessionId(),
		});
		await shutdownStartedPromise;
		copyFileSync(targetReplacement.getSessionFile()!, targetSessionFile);
		releaseShutdown();
		await recoveryStartedPromise;
		copyFileSync(outgoingReplacement.getSessionFile()!, outgoingSessionFile);
		releaseRecovery();
		const result = await switchPromise;

		// Then
		expect(result).toEqual({ cancelled: true });
		expect(runtime.session.sessionManager.getSessionId()).toBe(outgoingSessionId);
		expect(runtime.session.sessionManager.isPersisted()).toBe(false);
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(runtime.session.extensionRunner.isActive).toBe(true);
		expect(shutdownCount).toBe(2);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.sessionId}`)).toBe(true);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("reports why an unflushed session cannot be forked", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const sessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);
		expect(leafId).toBeTruthy();

		await expect(runtime.fork(leafId!, { position: "at" })).rejects.toThrow(
			"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
		);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
