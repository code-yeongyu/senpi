import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionResumePreparationError,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { getMcpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { getToolSearchService } from "../../src/core/extensions/builtin/tool-search/service.ts";
import { assertConfiguredSessionResumeUsable } from "../../src/core/sdk.ts";
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
		vi.restoreAllMocks();
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			cwd?: string;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			beforePrepare?: () => Promise<void>;
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

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
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
		createRuntime.prepareResume = async ({ sessionManager }) => {
			await options?.beforePrepare?.();
			await assertConfiguredSessionResumeUsable(
				{ model: runtimeOptions.model },
				sessionManager,
				runtime.services.modelRuntime,
				runtime.services.settingsManager,
				[],
			);
		};
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

	it("keeps the real builtin runtime usable when read-only resume admission rejects before candidate construction", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime, faux, tempDir } = await createRuntimeForTest((pi) => {
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
		await runtime.session.prompt("current session");
		const oldSession = runtime.session;
		const oldServices = runtime.services;
		const oldContext = oldSession.extensionRunner.createContext();
		// The real DefaultResourceLoader includes these builtins; a plain prompt
		// can otherwise succeed while extension errors are swallowed by the runner.
		expect(oldSession.extensionRunner.getExtensionIdentities().map((extension) => extension.path)).toEqual(
			expect.arrayContaining(["<builtin:tool-search>", "<builtin:mcp>"]),
		);
		const extensionErrors = vi.fn();
		oldSession.extensionRunner.onError(extensionErrors);
		const oldToolSearch = getToolSearchService();
		const mcpSubscribe = vi.spyOn(getMcpService(), "onWireStatusChanged");
		const oldMessages = [...oldSession.messages];
		const oldFile = readFileSync(oldSession.sessionFile!, "utf8");
		const target = SessionManager.create(tempDir, join(tempDir, "sessions"));
		target.appendModelChange(faux.getModel().provider, faux.getModel().id);
		target.appendThinkingLevelChange("off");
		target.appendMessage({
			role: "user",
			content: "x".repeat(faux.getModel().contextWindow * 4),
			timestamp: Date.now(),
		});
		target.appendMessage(fauxAssistantMessage("saved response"));
		const targetFile = target.getSessionFile()!;
		const targetContents = readFileSync(targetFile, "utf8");
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		const abort = vi.spyOn(oldSession, "abort");
		const invalidate = vi.spyOn(oldSession.extensionRunner, "invalidate");
		const beforeInvalidate = vi.fn();
		const rebind = vi.fn(async () => {});
		runtime.setBeforeSessionInvalidate(beforeInvalidate);
		runtime.setRebindSession(rebind);
		events.length = 0;

		const error = await runtime.switchSession(targetFile).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(SessionResumePreparationError);
		if (!(error instanceof SessionResumePreparationError)) throw new Error("expected preparation failure");
		expect(error.cause).toBeInstanceOf(ModelUsabilityBudgetError);
		expect(error.cause).toMatchObject({
			projection: { admission: "resume", usable: false, speculationLeadTokens: 0 },
		});
		expect(events).toEqual([{ type: "session_before_switch", reason: "resume", targetSessionFile: targetFile }]);
		expect(abort).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(beforeInvalidate).not.toHaveBeenCalled();
		expect(rebind).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(runtime.session).toBe(oldSession);
		expect(runtime.services).toBe(oldServices);
		expect(oldContext.cwd).toBe(oldServices.cwd);
		expect(oldSession.messages).toEqual(oldMessages);
		expect(readFileSync(oldSession.sessionFile!, "utf8")).toBe(oldFile);
		expect(readFileSync(targetFile, "utf8")).toBe(targetContents);
		expect(getToolSearchService()).toBe(oldToolSearch);
		expect(() => oldToolSearch.getCatalog()).not.toThrow();
		expect(mcpSubscribe).not.toHaveBeenCalled();

		const observed: string[] = [];
		oldSession.subscribe((event) => {
			observed.push(event.type);
		});
		await oldSession.prompt("still usable");
		expect(observed).toContain("message_end");
		expect(extensionErrors).not.toHaveBeenCalled();
		expect(oldSession.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "two" }] });
		expect(SessionManager.open(oldSession.sessionFile!).buildSessionContext().messages).toEqual(oldSession.messages);
	});

	it("does not clean up provider resources owned by the same saved session when an unbound candidate is rejected", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("saved current session");
		const oldSession = runtime.session;
		// Simulate disk history exceeding current admission without changing the
		// live runtime's already-loaded branch or invoking a real provider.
		const diskSession = SessionManager.open(oldSession.sessionFile!);
		diskSession.appendMessage({
			role: "user",
			content: "x".repeat(faux.getModel().contextWindow * 4),
			timestamp: Date.now(),
		});
		const cleanupResources = vi.fn();
		const unregister = registerSessionResourceCleanup(cleanupResources);
		try {
			await expect(runtime.switchSession(oldSession.sessionFile!)).rejects.toBeInstanceOf(
				SessionResumePreparationError,
			);
			expect(cleanupResources).not.toHaveBeenCalled();
			expect(runtime.session).toBe(oldSession);
			await oldSession.prompt("still active");
			expect(cleanupResources).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});

	it("keeps the current session alive while asynchronous target preparation fails", async () => {
		const preparing = Promise.withResolvers<void>();
		const preparation = Promise.withResolvers<void>();
		let rejectPreparation = false;
		const shutdown = vi.fn();
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_shutdown", shutdown);
			},
			{
				beforePrepare: async () => {
					if (!rejectPreparation) return;
					preparing.resolve();
					await preparation.promise;
				},
			},
		);
		await runtime.session.prompt("target");
		const target = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});
		const oldSession = runtime.session;
		const abort = vi.spyOn(oldSession, "abort");
		const invalidate = vi.fn();
		runtime.setBeforeSessionInvalidate(invalidate);
		shutdown.mockClear();
		rejectPreparation = true;
		const error = new Error("target services unavailable");
		const switchPromise = runtime.switchSession(target);
		const rejected = expect(switchPromise).rejects.toMatchObject({
			name: "SessionResumePreparationError",
			cause: error,
		});
		await preparing.promise;
		expect(runtime.session).toBe(oldSession);
		expect(oldSession.extensionRunner.isActive).toBe(true);
		await oldSession.prompt("works during preparation");
		preparation.reject(error);
		await rejected;
		expect(runtime.session).toBe(oldSession);
		expect(abort).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("does not construct a candidate if outgoing teardown fails after read-only admission", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("target");
		const target = runtime.session.sessionFile!;
		await runtime.newSession();
		const oldSession = runtime.session;
		const error = new Error("outgoing abort failed");
		vi.spyOn(oldSession, "abort").mockRejectedValueOnce(error);
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");

		await expect(runtime.switchSession(target)).rejects.toBe(error);

		expect(dispose).not.toHaveBeenCalled();
		expect(runtime.session).toBe(oldSession);
	});

	it("preserves shutdown, invalidation, rebind/start, and withSession ordering on successful resume", async () => {
		const phases: string[] = [];
		const { runtime } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", () => {
				phases.push("before");
			});
			pi.on("session_shutdown", () => {
				phases.push("shutdown");
			});
			pi.on("session_start", () => {
				phases.push("start");
			});
		});
		await runtime.session.prompt("target");
		const target = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});
		const oldSession = runtime.session;
		runtime.setBeforeSessionInvalidate(() => {
			phases.push("invalidate");
			expect(oldSession.extensionRunner.isActive).toBe(true);
		});
		runtime.setRebindSession(async (session) => {
			phases.push("rebind");
			expect(oldSession.extensionRunner.isActive).toBe(false);
			await session.bindExtensions({});
		});
		phases.length = 0;

		await runtime.switchSession(target, {
			withSession: async () => {
				phases.push("withSession");
			},
		});

		expect(phases).toEqual(["before", "shutdown", "invalidate", "rebind", "start", "withSession"]);
		runtime.setBeforeSessionInvalidate(undefined);
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
});
