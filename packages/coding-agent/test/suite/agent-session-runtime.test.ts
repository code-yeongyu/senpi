import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	registerSessionResourceCleanup,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { estimateTokens } from "../../src/core/compaction/compaction.ts";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
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
			cwd?: string;
			bootstrapModel?: boolean;
			bootstrapModelId?: string;
			bootstrapThinkingLevel?: boolean;
			destinationDefaultModel?: string;
			destinationReserveTokens?: number;
			destinationSystemPrompt?: string;
			destinationToolDescription?: string;
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
				{ id: "faux-medium", reasoning: false, contextWindow: 65536, maxTokens: 2048 },
				// A deliberately tiny context window so a transcript that fits the default
				// 128000-token model is over budget once resumed against this model.
				{ id: "faux-small", reasoning: false, contextWindow: 8192, maxTokens: 2048 },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(options?.bootstrapModelId ?? "faux-1"),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
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
						extensionFactory(pi);
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
				resourceLoaderOptions: {
					...runtimeOptions.resourceLoaderOptions,
					systemPrompt: sessionStartEvent?.reason === "resume" ? options?.destinationSystemPrompt : undefined,
				},
			});
			if (sessionStartEvent?.reason === "resume") {
				services.settingsManager.applyOverrides({
					...(options?.destinationDefaultModel
						? { defaultProvider: faux.getModel().provider, defaultModel: options.destinationDefaultModel }
						: {}),
					...(options?.destinationReserveTokens
						? { compaction: { reserveTokens: options.destinationReserveTokens } }
						: {}),
				});
			}
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
					customTools:
						sessionStartEvent?.reason === "resume" && options?.destinationToolDescription
							? [
									{
										name: "destination_tool",
										label: "Destination tool",
										description: options.destinationToolDescription,
										parameters: Type.Object({}),
										execute: async () => ({ content: [], details: {} }),
									},
								]
							: undefined,
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

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
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

	// PR #1473: explicit factory choices take precedence over stored models.
	it.each([
		{ forced: "faux-medium", stored: "faux-1", rejected: true },
		{ forced: "faux-1", stored: "faux-medium", rejected: false },
	])("admits the factory's $forced model rather than stored $stored", async ({ forced, stored, rejected }) => {
		const events: RecordedSessionEvent[] = [];
		const { runtime, faux, tempDir } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_before_switch", (event) => {
					events.push(event);
				});
				pi.on("session_shutdown", (event) => {
					events.push(event);
				});
			},
			{ bootstrapModelId: forced },
		);
		const target = SessionManager.create(tempDir, join(tempDir, "targets"));
		target.appendModelChange(faux.getModel().provider, stored);
		target.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: 1 });
		target.appendMessage({ ...fauxAssistantMessage("stored"), provider: faux.getModel().provider, model: stored });
		const path = target.getSessionFile();
		if (!path) throw new Error("missing target file");
		const bytes = readFileSync(path);
		const original = runtime.session;
		if (rejected) {
			await expect(runtime.switchSession(path)).rejects.toMatchObject({
				projection: { model: `${faux.getModel().provider}/${forced}`, admission: "resume" },
			});
			expect(events).toEqual([]);
			expect(readFileSync(path)).toEqual(bytes);
			expect(runtime.session).toBe(original);
			await expect(original.prompt("still usable")).resolves.toBeUndefined();
		} else {
			expect(await runtime.switchSession(path)).toEqual({ cancelled: false });
			expect(runtime.session.model?.id).toBe(forced);
			expect(SessionManager.open(path).buildSessionContext().messages).toEqual(runtime.session.messages);
		}
	});

	// PR #1473: destination services, not the live session, determine the whole budget.
	it.each([
		{ name: "stored-model fallback", bootstrapModel: false, destinationDefaultModel: "faux-medium" },
		{ name: "compaction settings", destinationReserveTokens: 100_000 },
		{ name: "system prompt", destinationSystemPrompt: "p".repeat(400_000) },
		{ name: "tool schemas", destinationToolDescription: "t".repeat(400_000) },
	])("rejects using destination $name before lifecycle effects", async (options) => {
		const events: RecordedSessionEvent[] = [];
		const { runtime, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
		}, options);
		const target = SessionManager.create(tempDir, join(tempDir, "targets"));
		target.appendModelChange("missing-provider", "missing-model");
		target.appendMessage({ role: "user", content: "x".repeat(60_000), timestamp: 1 });
		target.appendMessage({ ...fauxAssistantMessage("stored"), provider: "missing-provider", model: "missing-model" });
		const path = target.getSessionFile();
		if (!path) throw new Error("missing target file");
		const original = runtime.session;
		const tokens = target.buildSessionContext().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		expect(() =>
			original.assertModelUsable(original.model, tokens, { includeSpeculationLead: false, admission: "resume" }),
		).not.toThrow();
		await expect(runtime.switchSession(path)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		expect(events).toEqual([]);
		expect(runtime.session).toBe(original);
		await expect(original.prompt("still usable")).resolves.toBeUndefined();
	});

	// PR #1473: cancellation must not repair, initialize, or migrate the target.
	it("keeps live provider resources when a resume of the same session is cancelled", async () => {
		const { runtime } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", () => ({ cancel: true }));
		});
		await runtime.session.prompt("persist source");
		const path = runtime.session.sessionFile;
		if (!path) throw new Error("missing session file");
		const released: Array<string | undefined> = [];
		const unregister = registerSessionResourceCleanup((id) => released.push(id));
		try {
			expect(await runtime.switchSession(path)).toEqual({ cancelled: true });
			expect(released).toEqual([]);
		} finally {
			unregister();
		}
	});

	// PR #1473: cancellation must not repair, initialize, or migrate the target.
	it.each(["unterminated", "legacy", "empty"])("leaves a cancelled %s target byte-identical", async (kind) => {
		const { runtime, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", () => ({ cancel: true }));
		});
		const target = join(tempDir, "cancelled.jsonl");
		const header = {
			type: "session",
			version: kind === "legacy" ? 1 : 3,
			id: "cancelled",
			timestamp: "2026-09-08T00:00:00.000Z",
			cwd: tempDir,
		};
		const bytes = kind === "empty" ? "" : JSON.stringify(header);
		writeFileSync(target, bytes);
		const original = runtime.session;
		expect(await runtime.switchSession(target)).toEqual({ cancelled: true });
		expect(readFileSync(target, "utf8")).toBe(bytes);
		expect(runtime.session).toBe(original);
		expect(original.extensionRunner.isActive).toBe(true);
	});

	// Regression: a resume rejected by the model usability budget must run its
	// admission check BEFORE teardown, so the live session the user is still in is
	// never disposed/invalidated by a resume that will fail anyway.
	it("rejects an over-budget resume without invalidating the live session", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const originalSession = runtime.session;
		const originalSessionFile = runtime.session.sessionFile;

		// Seed a target session whose restored transcript far exceeds the current
		// model's context window (faux default contextWindow is 128000 tokens).
		const targetDir = join(tmpdir(), `pi-runtime-overbudget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(targetDir, { recursive: true });
		const targetSession = SessionManager.create(targetDir);
		const targetModel = runtime.session.model!;
		targetSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "x".repeat(4_000_000) }],
			timestamp: Date.now() - 1,
		});
		// A trailing assistant message flushes the buffered transcript to disk so the
		// re-opened session manager actually reports the over-budget live context.
		targetSession.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: targetModel.api,
			provider: targetModel.provider,
			model: targetModel.id,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		const targetSessionFile = targetSession.getSessionFile();
		cleanups.push(() => rmSync(targetDir, { recursive: true, force: true }));

		// PR #1473: a successful faux reply must not hide stale builtin callbacks.
		const extensionErrors: unknown[] = [];
		runtime.session.extensionRunner.onError((error) => extensionErrors.push(error));
		await expect(runtime.switchSession(targetSessionFile!)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		// The live session object and its file are unchanged...
		expect(runtime.session).toBe(originalSession);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
		// ...and it is still usable: teardown never disposed it, so its extension
		// runner was never invalidated (pre-fix, teardown ran first and the next
		// input crashed with the stale-context error).
		expect(runtime.session.extensionRunner.isActive).toBe(true);
		await expect(runtime.session.prompt("still here")).resolves.toBeUndefined();
		expect(extensionErrors).toEqual([]);
	});

	// Regression: the admission check must run against the model the resume will
	// actually restore (the destination session's stored model), not the live
	// session's model. When the active model has a bigger window than the restored
	// one, checking the active model passes preflight, tears down the live session,
	// then re-throws from the post-teardown check - the destructive failure.
	it("rejects a resume over the restored model's budget even when the active model would fit", async () => {
		const emittedBeforeSwitch: RecordedSessionEvent[] = [];
		// No explicit factory model, so the destination's stored model is what the
		// resume restores - the case this admission check has to judge.
		const { runtime, faux } = await createRuntimeForTest(
			(pi: ExtensionAPI) => {
				pi.on("session_before_switch", (event) => {
					emittedBeforeSwitch.push(event);
				});
			},
			{ bootstrapModel: false },
		);
		// Active session runs on the default 128000-token model.
		await runtime.session.prompt("hello");
		const originalSession = runtime.session;
		const originalSessionFile = runtime.session.sessionFile;

		// The destination session stores the tiny 8192-token model. Its transcript is
		// ~60000 tokens: comfortably inside the active model's window, far past the
		// restored model's. The user + assistant model entry make faux-small the
		// restored model on resume.
		const smallModel = faux.getModel("faux-small")!;
		const targetDir = join(
			tmpdir(),
			`pi-runtime-restored-model-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(targetDir, { recursive: true });
		const targetSession = SessionManager.create(targetDir);
		targetSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "x".repeat(60_000) }],
			timestamp: Date.now() - 1,
		});
		targetSession.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: smallModel.api,
			provider: smallModel.provider,
			model: smallModel.id,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		const targetSessionFile = targetSession.getSessionFile();
		cleanups.push(() => rmSync(targetDir, { recursive: true, force: true }));

		// Confirm the transcript fits the active model: checking it would pass.
		const activeTokens = SessionManager.open(targetSessionFile!)
			.buildSessionContext()
			.messages.reduce((total, message) => total + estimateTokens(message), 0);
		expect(() =>
			originalSession.assertModelUsable(originalSession.model, activeTokens, {
				includeSpeculationLead: false,
				admission: "resume",
			}),
		).not.toThrow();

		await expect(runtime.switchSession(targetSessionFile!)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		// Non-mutating preflight ran before the switch lifecycle event, so a rejected
		// resume is a true no-op: no session_before_switch was ever emitted.
		expect(emittedBeforeSwitch).toEqual([]);
		expect(runtime.session).toBe(originalSession);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
		expect(runtime.session.extensionRunner.isActive).toBe(true);
		await expect(runtime.session.prompt("still here")).resolves.toBeUndefined();
	});
});
