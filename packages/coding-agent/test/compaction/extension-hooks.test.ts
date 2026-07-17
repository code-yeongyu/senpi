import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	type ContextUsage,
	createExtensionRuntime,
	type Extension,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionCompactEvent,
} from "../../src/core/extensions/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { assistantMsg, createTestResourceLoader, userMsg } from "../utilities.ts";

type Registration = ReturnType<typeof registerFauxProvider>;
type TestHandler = (...args: unknown[]) => Promise<unknown>;

describe("Compaction extension hooks", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;
	let registration: Registration | undefined;
	let capturedEvents: Array<SessionBeforeCompactEvent | SessionCompactEvent>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compaction-hooks-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		registration = registerFauxProvider({ models: [{ id: "faux-compact", contextWindow: 32_000 }] });
		capturedEvents = [];
	});

	afterEach(() => {
		session?.dispose();
		registration?.unregister();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function isExtensionContext(value: unknown): value is ExtensionContext {
		return (
			typeof value === "object" &&
			value !== null &&
			"getContextUsage" in value &&
			typeof value.getContextUsage === "function"
		);
	}

	function isSessionBeforeCompactEvent(value: unknown): value is SessionBeforeCompactEvent {
		return typeof value === "object" && value !== null && "type" in value && value.type === "session_before_compact";
	}

	function isSessionCompactEvent(value: unknown): value is SessionCompactEvent {
		return typeof value === "object" && value !== null && "type" in value && value.type === "session_compact";
	}

	function createExtension(
		onBeforeCompact?: (
			event: SessionBeforeCompactEvent,
			ctx: ExtensionContext,
		) => SessionBeforeCompactResult | undefined,
		onCompact?: (event: SessionCompactEvent, ctx: ExtensionContext) => void,
	): Extension {
		const beforeHandler: TestHandler = async (event, ctx) => {
			if (!isSessionBeforeCompactEvent(event) || !isExtensionContext(ctx)) {
				throw new Error("Unexpected session_before_compact handler payload");
			}
			capturedEvents.push(event);
			return onBeforeCompact?.(event, ctx);
		};

		const compactHandler: TestHandler = async (event, ctx) => {
			if (!isSessionCompactEvent(event) || !isExtensionContext(ctx)) {
				throw new Error("Unexpected session_compact handler payload");
			}
			capturedEvents.push(event);
			onCompact?.(event, ctx);
			return undefined;
		};

		return {
			path: "test-extension",
			resolvedPath: "/test/test-extension.ts",
			sourceInfo: createSyntheticSourceInfo("<test:test-extension>", { source: "test" }),
			handlers: new Map([
				["session_before_compact", [beforeHandler]],
				["session_compact", [compactHandler]],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
			mcpServers: new Map(),
			registrationCwd: process.cwd(),
		};
	}

	function createSession(extensions: Extension[]): AgentSession {
		const model = registration?.getModel("faux-compact");
		if (!model) {
			throw new Error("faux-compact model was not registered");
		}

		const agent = new Agent({
			getApiKey: () => undefined,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const runtime = createExtensionRuntime();
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => ({ extensions, errors: [], runtime }),
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader,
		});

		return session;
	}

	function seedCompactableSession(): void {
		sessionManager.appendMessage(userMsg("What is 2+2?"));
		sessionManager.appendMessage(assistantMsg("4"));
		sessionManager.appendMessage(userMsg("What is 3+3?"));
		sessionManager.appendMessage(assistantMsg("6"));
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
	}

	describe("Given a session_before_compact handler that returns a custom compaction result", () => {
		describe("When compaction is triggered without configured model auth", () => {
			it("Then the extension summary is used without requiring API credentials", async () => {
				// given
				const customSummary = "Custom summary from extension";
				const extension = createExtension((event) => ({
					compaction: {
						summary: customSummary,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
				createSession([extension]);
				seedCompactableSession();

				// when
				const result = await session.compact();

				// then
				expect(result.summary).toBe(customSummary);
				const compactEvents = capturedEvents.filter(isSessionCompactEvent);
				expect(compactEvents).toHaveLength(1);
				expect(compactEvents[0]?.fromExtension).toBe(true);
				expect(compactEvents[0]?.compactionEntry.summary).toBe(customSummary);
			});
		});
	});

	describe("Given a session_before_compact handler that returns cancel", () => {
		describe("When compaction is triggered", () => {
			it("Then no compaction occurs and no session_compact event is emitted", async () => {
				// given
				const extension = createExtension(() => ({ cancel: true }));
				createSession([extension]);
				seedCompactableSession();

				// when
				const result = session.compact();

				// then
				await expect(result).rejects.toThrow("Compaction cancelled");
				const compactEvents = capturedEvents.filter(isSessionCompactEvent);
				expect(compactEvents).toHaveLength(0);
			});
		});
	});

	describe("Given a session_before_compact handler that reads context usage", () => {
		describe("When compaction is triggered", () => {
			it("Then the extension context exposes current usage", async () => {
				// given
				let contextUsage: ContextUsage | undefined;
				const extension = createExtension((event, ctx) => {
					contextUsage = ctx.getContextUsage();
					return {
						compaction: {
							summary: "Context usage summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
				createSession([extension]);
				seedCompactableSession();

				// when
				await session.compact();

				// then
				expect(contextUsage).toBeDefined();
				expect(contextUsage?.tokens).toEqual(expect.any(Number));
				expect(contextUsage?.contextWindow).toBe(32_000);
				expect(contextUsage?.percent).toEqual(expect.any(Number));
			});
		});
	});

	describe("Given a session with an extension that observes compaction", () => {
		describe("When compaction completes", () => {
			it("Then the session_compact event payload includes the saved compaction entry", async () => {
				// given
				const extension = createExtension((event) => ({
					compaction: {
						summary: "Saved compaction summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
				createSession([extension]);
				seedCompactableSession();

				// when
				await session.compact();

				// then
				const compactEvents = capturedEvents.filter(isSessionCompactEvent);
				expect(compactEvents).toHaveLength(1);
				expect(compactEvents[0]?.accepted).toBe(true);
				expect(compactEvents[0]?.compactionEntry.summary).toBe("Saved compaction summary");
				expect(compactEvents[0]?.compactionEntry.tokensBefore).toBeGreaterThanOrEqual(0);
			});
		});
	});
});
