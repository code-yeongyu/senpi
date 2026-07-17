import { createModelRegistry } from "./model-runtime-test-utils.ts";
/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "../src/core/extensions/loader.ts";
import {
	ExtensionRunner,
	type ExtensionToolHookLifecycleEvent,
	emitProjectTrustEvent,
} from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
	ProviderConfig,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager, type KeyId } from "../src/core/keybindings.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("ExtensionRunner", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	const defaultKeybindings = new KeybindingsManager().getEffectiveConfig();

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = await createModelRegistry(authStorage);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const providerModelConfig: ProviderConfig = {
		baseUrl: "https://provider.test/v1",
		apiKey: "provider-test-key",
		api: "openai-completions",
		models: [
			{
				id: "instant-model",
				name: "Instant Model",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 1,
					output: 2,
					cacheRead: 0.1,
					cacheWrite: 1.25,
					tiers: [
						{
							inputTokensAbove: 272000,
							input: 2,
							output: 3,
							cacheRead: 0.2,
							cacheWrite: 2.5,
						},
					],
				},
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		executeTool: async <TDetails = unknown>() => ({ content: [], details: undefined as TDetails }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		getServiceTier: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		getSystemPrompt: () => "",
		getLoadedHookSources: () => ({
			agentDir: tempDir,
			cwd: tempDir,
			globalHookSourcePaths: [],
			globalHooksPath: path.join(tempDir, "hooks.json"),
			preSessionHookSourcePaths: [],
			projectHookSourcePaths: [],
			projectHooksPath: path.join(tempDir, ".senpi", "hooks.json"),
			runtimeHookSourcePaths: [],
		}),
	};

	type JsonContextFixture = {
		readonly messages: AgentMessage[];
		readonly providerRaw: Record<string, unknown>;
		readonly toolDetails: Record<string, unknown>;
	};

	const createJsonContextFixture = (): JsonContextFixture => {
		const providerRaw = {
			query: "json clone",
			results: [
				{ title: "first", score: 0.98, flags: [true, false], extra: null },
				{ title: "second", score: 0.87, flags: [], extra: { source: "fixture" } },
			],
			meta: {
				ok: true,
				count: 2,
				note: "provider native payload",
			},
		};
		const toolDetails = {
			status: "complete",
			attempt: 1,
			values: [1, "two", false, null],
			nested: {
				files: ["a.ts", "b.ts"],
				timing: { elapsedMs: 12.5 },
			},
		};
		return {
			providerRaw,
			toolDetails,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								task: "inspect",
								input: { plain: true, count: 3, tags: ["json", "context"] },
							}),
						},
					],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the JSON context." },
						{ type: "providerNative", subtype: "web_search_call", raw: providerRaw },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-json",
					toolName: "inspect_json",
					content: [{ type: "text", text: "inspected JSON payload" }],
					details: toolDetails,
					isError: false,
					timestamp: 3,
				},
			],
		};
	};

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
		if (!isRecord(value)) {
			throw new Error(`Expected ${label} to be a record`);
		}
		return value;
	};

	const requireAssistantProviderRaw = (messages: AgentMessage[]): unknown => {
		const assistant = messages.find((message) => message.role === "assistant");
		if (assistant?.role !== "assistant") {
			throw new Error("Expected assistant message");
		}
		const providerNative = assistant.content.find((content) => content.type === "providerNative");
		if (providerNative?.type !== "providerNative") {
			throw new Error("Expected providerNative content");
		}
		return providerNative.raw;
	};

	const requireToolDetails = (messages: AgentMessage[]): Record<string, unknown> => {
		const toolResult = messages.find((message) => message.role === "toolResult");
		if (toolResult?.role !== "toolResult") {
			throw new Error("Expected tool result message");
		}
		return requireRecord(toolResult.details, "tool result details");
	};

	describe("project_trust", () => {
		it("continues past undecided handlers and returns the first yes/no decision", async () => {
			const undecidedPath = path.join(extensionsDir, "undecided.ts");
			const decidedPath = path.join(extensionsDir, "decided.ts");
			fs.writeFileSync(
				undecidedPath,
				`export default function(pi) {
	pi.on("project_trust", () => ({ trusted: "undecided", remember: true }));
}`,
			);
			fs.writeFileSync(
				decidedPath,
				`export default function(pi) {
	pi.on("project_trust", () => ({ trusted: "no", remember: true }));
}`,
			);

			const extensionsResult = await loadExtensions([undecidedPath, decidedPath], tempDir);
			const result = await emitProjectTrustEvent(
				extensionsResult,
				{ type: "project_trust", cwd: tempDir },
				{
					cwd: tempDir,
					mode: "tui",
					hasUI: false,
					ui: {
						select: async () => undefined,
						confirm: async () => false,
						input: async () => undefined,
						notify: () => {},
					},
				},
			);

			expect(result.result).toEqual({ trusted: "no", remember: true });
			expect(result.errors).toEqual([]);
		});
	});

	describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it("allows a shortcut when the reserved set no longer contains the default key", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+p", {
						description: "Uses freed default",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebinding.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.model.cycleForward": "ctrl+n" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(shortcuts.has("ctrl+p")).toBe(true);
			expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));

			warnSpy.mockRestore();
		});

		it("warns but allows when extension uses non-reserved built-in shortcut", async () => {
			const pasteImageKey = Array.isArray(defaultKeybindings["app.clipboard.pasteImage"])
				? (defaultKeybindings["app.clipboard.pasteImage"][0] ?? "")
				: defaultKeybindings["app.clipboard.pasteImage"];
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("${pasteImageKey}", {
						description: "Overrides non-reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has(pasteImageKey as KeyId)).toBe(true);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts for reserved actions even when rebound", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+x", {
						description: "Conflicts with rebound reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "rebound-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.interrupt": "ctrl+x" as KeyId };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+x")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved key is also bound to non-reserved actions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+p", {
						description: "Conflicts with shared reserved default",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "shared-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+p")).toBe(false);

			warnSpy.mockRestore();
		});

		it("blocks shortcuts when reserved action has multiple keys", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+y", {
						description: "Conflicts with multi-key reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clear": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"));
			expect(shortcuts.has("ctrl+y")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns but allows when non-reserved action has multiple keys", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+y", {
						description: "Overrides multi-key non-reserved",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "multi-non-reserved.ts"), extCode);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const keybindings = { ...defaultKeybindings, "app.clipboard.pasteImage": ["ctrl+x", "ctrl+y"] as KeyId[] };
			const shortcuts = runner.getShortcuts(keybindings);

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("built-in shortcut for app.clipboard.pasteImage"),
			);
			expect(shortcuts.has("ctrl+y")).toBe(true);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						handler: async () => {},
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const shortcuts = runner.getShortcuts(defaultKeybindings);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

	describe("tool collection", () => {
		it("collects tools from multiple extensions", async () => {
			const toolCode = (name: string) => `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "${name}",
						label: "${name}",
						description: "Test tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), toolCode("tool_a"));
			fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), toolCode("tool_b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools.length).toBe(2);
			expect(tools.map((t) => t.definition.name).sort()).toEqual(["tool_a", "tool_b"]);
		});

		it("keeps first tool when two extensions register the same name", async () => {
			const first = `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "shared",
						label: "shared",
						description: "first",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			const second = `
				import { Type } from "typebox";
				export default function(pi) {
					pi.registerTool({
						name: "shared",
						label: "shared",
						description: "second",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const tools = runner.getAllRegisteredTools();

			expect(tools).toHaveLength(1);
			expect(tools[0]?.definition.description).toBe("first");
		});
	});

	describe("command collection", () => {
		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export default function(pi) {
					pi.registerCommand("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map((c) => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
			expect(commands.map((c) => c.invocationName).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by invocation name", async () => {
			const cmdCode = `
				export default function(pi) {
					pi.registerCommand("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd.ts"), cmdCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.invocationName).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("suffixes duplicate extension commands in insertion order", async () => {
			const cmdCode = (description: string) => `
				export default function(pi) {
					pi.registerCommand("shared-cmd", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("First command"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("Second command"));

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const commands = runner.getRegisteredCommands();
			const diagnostics = runner.getCommandDiagnostics();

			expect(commands).toHaveLength(2);
			expect(commands.map((command) => command.name)).toEqual(["shared-cmd", "shared-cmd"]);
			expect(commands.map((command) => command.invocationName)).toEqual(["shared-cmd:1", "shared-cmd:2"]);
			expect(commands.map((command) => command.description)).toEqual(["First command", "Second command"]);
			expect(diagnostics).toEqual([]);
			expect(runner.getCommand("shared-cmd:1")?.description).toBe("First command");
			expect(runner.getCommand("shared-cmd:2")?.description).toBe("Second command");
		});
	});

	describe("context creation", () => {
		it("exposes the current abort signal on ExtensionContext", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const controller = new AbortController();

			runner.bindCore(extensionActions, {
				...extensionContextActions,
				getSignal: () => controller.signal,
			});

			const ctx = runner.createContext();
			expect(ctx.signal).toBe(controller.signal);
			expect(ctx.signal?.aborted).toBe(false);

			controller.abort();
			expect(ctx.signal?.aborted).toBe(true);
		});

		it("exposes print mode and hasUI false by default", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("print");
			expect(ctx.hasUI).toBe(false);
		});

		it("exposes project trust state on ExtensionContext", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, {
				...extensionContextActions,
				isProjectTrusted: () => false,
			});

			const ctx = runner.createContext();
			expect(ctx.isProjectTrusted()).toBe(false);
		});

		it("exposes rpc mode with hasUI true when an RPC UI context is provided", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);
			runner.setUIContext({} as ExtensionUIContext, "rpc");

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("rpc");
			expect(ctx.hasUI).toBe(true);
		});

		it("exposes tui mode with hasUI true when a TUI UI context is provided", async () => {
			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);
			runner.setUIContext({} as ExtensionUIContext, "tui");

			const ctx = runner.createContext();
			expect(ctx.mode).toBe("tui");
			expect(ctx.hasUI).toBe(true);
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError((err) => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});
	});

	describe("context event cloning", () => {
		it("passes JSON context messages through as deep-equal isolated clones", async () => {
			const { messages, providerRaw, toolDetails } = createJsonContextFixture();
			const runtime = createExtensionRuntime();
			let handlerMessages: AgentMessage[] | undefined;
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("context", async (event) => {
						handlerMessages = event.messages;
						return undefined;
					});
				},
				tempDir,
				createEventBus(),
				runtime,
				"<inline:context-clone-parity>",
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);

			const result = await runner.emitContext(messages);

			expect(result).toEqual(messages);
			expect(result).not.toBe(messages);
			expect(result[0]).not.toBe(messages[0]);
			expect(handlerMessages).toBe(result);
			expect(requireAssistantProviderRaw(result)).toEqual(providerRaw);
			expect(requireAssistantProviderRaw(result)).not.toBe(providerRaw);
			expect(requireToolDetails(result)).toEqual(toolDetails);
			expect(requireToolDetails(result)).not.toBe(toolDetails);
		});

		it("does not call structuredClone for the hot emitContext clone", async () => {
			const { messages } = createJsonContextFixture();
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("context", async (event) => ({ messages: event.messages }));
				},
				tempDir,
				createEventBus(),
				runtime,
				"<inline:context-json-clone>",
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
			const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation(<_T>() => {
				throw new Error("structuredClone hot path should not run");
			});

			try {
				const result = await runner.emitContext(messages);

				expect(result).toEqual(messages);
				expect(structuredCloneSpy).not.toHaveBeenCalled();
			} finally {
				structuredCloneSpy.mockRestore();
			}
		});

		it("keeps original JSON context messages isolated from handler mutations", async () => {
			const { messages, providerRaw, toolDetails } = createJsonContextFixture();
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("context", async (event) => {
						const raw = requireRecord(requireAssistantProviderRaw(event.messages), "providerNative raw");
						const meta = requireRecord(raw.meta, "providerNative raw meta");
						meta.count = 99;
						raw.mutated = true;

						const details = requireToolDetails(event.messages);
						const nested = requireRecord(details.nested, "tool result nested details");
						nested.files = ["mutated.ts"];
						details.status = "mutated";

						return { messages: event.messages };
					});
				},
				tempDir,
				createEventBus(),
				runtime,
				"<inline:context-clone-mutation>",
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);

			const result = await runner.emitContext(messages);

			expect(result).not.toEqual(messages);
			expect(providerRaw).toEqual({
				query: "json clone",
				results: [
					{ title: "first", score: 0.98, flags: [true, false], extra: null },
					{ title: "second", score: 0.87, flags: [], extra: { source: "fixture" } },
				],
				meta: {
					ok: true,
					count: 2,
					note: "provider native payload",
				},
			});
			expect(toolDetails).toEqual({
				status: "complete",
				attempt: 1,
				values: [1, "two", false, null],
				nested: {
					files: ["a.ts", "b.ts"],
					timing: { elapsedMs: 12.5 },
				},
			});
			expect(requireRecord(requireAssistantProviderRaw(result), "result providerNative raw").mutated).toBe(true);
			expect(requireToolDetails(result).status).toBe("mutated");
		});
	});

	describe("message and entry renderers", () => {
		it("gets message renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMessageRenderer("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "renderer.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});

		it("gets entry renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerEntryRenderer("my-entry", (entry, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "entry-renderer.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.getEntryRenderer("my-entry")).toBeDefined();
			expect(runner.getEntryRenderer("not-exists")).toBeUndefined();
		});
	});

	describe("flags", () => {
		it("collects flags from extensions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("my-flag", {
						description: "My flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const flags = runner.getFlags();

			expect(flags.has("my-flag")).toBe(true);
		});

		it("keeps first flag when two extensions register the same name", async () => {
			const first = `
				export default function(pi) {
					pi.registerFlag("shared-flag", {
						description: "first",
						type: "boolean",
						default: true,
					});
				}
			`;
			const second = `
				export default function(pi) {
					pi.registerFlag("shared-flag", {
						description: "second",
						type: "boolean",
						default: false,
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-first.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "b-second.ts"), second);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const flags = runner.getFlags();

			expect(flags.get("shared-flag")?.description).toBe("first");
			expect(result.runtime.flagValues.get("shared-flag")).toBe(true);
		});

		it("can set flag values", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("test-flag", {
						description: "Test flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "flag.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			// Setting a flag value should not throw
			runner.setFlagValue("--test-flag", true);

			// The flag values are stored in the shared runtime
			expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
		});
	});

	describe("before_agent_start", () => {
		it("keeps ctx.getSystemPrompt() in sync with chained system prompt updates", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nfirst",
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_agent_start", async (_event, ctx) => {
						return {
							systemPrompt: ctx.getSystemPrompt() + "\\nsecond",
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "before-agent-start-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(2);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));
			runner.bindCore(extensionActions, extensionContextActions);

			const chained = await runner.emitBeforeAgentStart("hello", undefined, "base", {
				cwd: tempDir,
			});

			expect(errors).toEqual([]);

			expect(chained).toEqual({
				messages: undefined,
				systemPrompt: "base\nfirst\nsecond",
			});
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-2.ts"), extCode2);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-2",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("tool hook lifecycle observer", () => {
		it("reports completed PreToolUse and PostToolUse handler runs", async () => {
			const runtime = createExtensionRuntime();
			const handlerEvents: string[] = [];
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("tool_call", async () => {
						handlerEvents.push("handler:PreToolUse");
					});
					pi.on("tool_result", async () => {
						handlerEvents.push("handler:PostToolUse");
					});
				},
				tempDir,
				createEventBus(),
				runtime,
				"<builtin:permission-system>",
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
			const lifecycleEvents: ExtensionToolHookLifecycleEvent[] = [];
			runner.setToolHookLifecycleObserver((event) => lifecycleEvents.push(event));

			await runner.emitToolCall({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "call-1",
				input: {},
			});
			await runner.emitToolResult({
				type: "tool_result",
				toolName: "bash",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "ok" }],
				details: {},
				isError: false,
			});

			expect(lifecycleEvents.map((event) => `${event.phase}:${event.hookName}`)).toEqual([
				"start:PreToolUse",
				"end:PreToolUse",
				"start:PostToolUse",
				"end:PostToolUse",
			]);
			expect(lifecycleEvents[0]).toMatchObject({
				phase: "start",
				hookName: "PreToolUse",
				statusMessage: "matching project rules",
				extensionPath: "<builtin:permission-system>",
			});
			expect(lifecycleEvents[1]).toMatchObject({
				phase: "end",
				hookName: "PreToolUse",
				status: "completed",
			});
			expect(handlerEvents).toEqual(["handler:PreToolUse", "handler:PostToolUse"]);
		});

		it("reports blocked PreToolUse handler runs", async () => {
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "no" }));
				},
				tempDir,
				createEventBus(),
				runtime,
				"<builtin:permission-system>",
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
			const lifecycleEvents: ExtensionToolHookLifecycleEvent[] = [];
			runner.setToolHookLifecycleObserver((event) => lifecycleEvents.push(event));

			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "call-blocked",
				input: {},
			});

			expect(result).toEqual({ block: true, reason: "no" });
			expect(lifecycleEvents.map((event) => `${event.phase}:${event.hookName}`)).toEqual([
				"start:PreToolUse",
				"end:PreToolUse",
			]);
			expect(lifecycleEvents[1]).toMatchObject({ phase: "end", status: "blocked" });
		});

		it("reports failed PostToolUse handlers and continues chaining later handlers", async () => {
			const runtime = createExtensionRuntime();
			const firstExtension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("tool_result", async () => {
						throw new Error("boom");
					});
				},
				tempDir,
				createEventBus(),
				runtime,
				"<inline:failing>",
			);
			const secondExtension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("tool_result", async () => ({
						content: [{ type: "text", text: "patched" }],
					}));
				},
				tempDir,
				createEventBus(),
				runtime,
				"<inline:patching>",
			);
			const runner = new ExtensionRunner(
				[firstExtension, secondExtension],
				runtime,
				tempDir,
				sessionManager,
				modelRegistry,
			);
			const lifecycleEvents: ExtensionToolHookLifecycleEvent[] = [];
			runner.setToolHookLifecycleObserver((event) => lifecycleEvents.push(event));

			const result = await runner.emitToolResult({
				type: "tool_result",
				toolName: "bash",
				toolCallId: "call-result",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: {},
				isError: false,
			});

			expect(result?.content).toEqual([{ type: "text", text: "patched" }]);
			expect(lifecycleEvents.map((event) => `${event.phase}:${event.hookName}`)).toEqual([
				"start:PostToolUse",
				"end:PostToolUse",
				"start:PostToolUse",
				"end:PostToolUse",
			]);
			expect(lifecycleEvents[1]).toMatchObject({
				phase: "end",
				status: "failed",
				errorMessage: "boom",
			});
			expect(lifecycleEvents[3]).toMatchObject({
				phase: "end",
				status: "completed",
			});
		});

		it("emits update events while a handler reports live tool hook status", async () => {
			const runtime = createExtensionRuntime();
			let staleUpdater: ((statusMessage: string) => void) | undefined;
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("tool_result", async (_event, ctx) => {
						ctx.updateToolHookStatus?.("(OmO) Checking Comments");
						staleUpdater = ctx.updateToolHookStatus;
					});
				},
				tempDir,
				createEventBus(),
				runtime,
				"<builtin:hooks>",
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
			const lifecycleEvents: ExtensionToolHookLifecycleEvent[] = [];
			runner.setToolHookLifecycleObserver((event) => lifecycleEvents.push(event));

			await runner.emitToolResult({
				type: "tool_result",
				toolName: "bash",
				toolCallId: "call-update",
				input: {},
				content: [{ type: "text", text: "ok" }],
				details: {},
				isError: false,
			});

			expect(lifecycleEvents.map((event) => event.phase)).toEqual(["start", "update", "end"]);
			expect(lifecycleEvents[0]).toMatchObject({
				phase: "start",
				statusMessage: "running hooks",
				extensionPath: "<builtin:hooks>",
			});
			expect(lifecycleEvents[1]).toMatchObject({
				phase: "update",
				hookRunId: lifecycleEvents[0]?.hookRunId,
				statusMessage: "(OmO) Checking Comments",
				startedAt: lifecycleEvents[0]?.startedAt,
			});
			expect(lifecycleEvents[2]).toMatchObject({
				phase: "end",
				status: "completed",
				statusMessage: "(OmO) Checking Comments",
			});

			staleUpdater?.("too late");
			expect(lifecycleEvents).toHaveLength(3);
		});

		it("sanitizes and bounds live tool hook status updates", async () => {
			const runtime = createExtensionRuntime();
			const longMessage = "x".repeat(200);
			const noisyMessage = "line\u001b[31mone\ntwo\t\u0007 done";
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("tool_call", async (_event, ctx) => {
						ctx.updateToolHookStatus?.(noisyMessage);
						ctx.updateToolHookStatus?.(longMessage);
					});
				},
				tempDir,
				createEventBus(),
				runtime,
				"<builtin:hooks>",
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
			const lifecycleEvents: ExtensionToolHookLifecycleEvent[] = [];
			runner.setToolHookLifecycleObserver((event) => lifecycleEvents.push(event));

			await runner.emitToolCall({
				type: "tool_call",
				toolName: "bash",
				toolCallId: "call-bounded",
				input: {},
			});

			const updates = lifecycleEvents.filter((event) => event.phase === "update");
			expect(updates[0]?.statusMessage).toBe("lineone two done");
			expect(updates[1]?.statusMessage).toBe(`${"x".repeat(76)}...`);
		});

		it("uses bounded custom hook status labels", async () => {
			const runtime = createExtensionRuntime();
			const extensionPath = path.join(tempDir, ".senpi", "extensions", "check-output.ts");
			const extension = await loadExtensionFromFactory(
				(pi) => {
					pi.on("tool_result", async () => undefined);
				},
				tempDir,
				createEventBus(),
				runtime,
				extensionPath,
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
			const lifecycleEvents: ExtensionToolHookLifecycleEvent[] = [];
			runner.setToolHookLifecycleObserver((event) => lifecycleEvents.push(event));

			await runner.emitToolResult({
				type: "tool_result",
				toolName: "bash",
				toolCallId: "call-label",
				input: {},
				content: [{ type: "text", text: "ok" }],
				details: {},
				isError: false,
			});

			expect(lifecycleEvents[0]?.statusMessage).toBe("running check-output");
			expect(lifecycleEvents[0]?.statusMessage.length).toBeLessThan(80);
		});
	});

	describe("provider registration", () => {
		it("bindCore ignores invalid queued registrations and reports extension error", async () => {
			const runtime = createExtensionRuntime();
			const brokenProviderConfig: ProviderConfig = {
				streamSimple: () => {
					throw new Error("should not run");
				},
			};
			runtime.registerProvider("broken-provider", brokenProviderConfig, "/tmp/broken-extension.ts");

			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(`${error.extensionPath}: ${error.error}`));

			expect(() => runner.bindCore(extensionActions, extensionContextActions)).not.toThrow();
			expect(errors).toEqual([
				'/tmp/broken-extension.ts: Provider broken-provider: "api" is required when registering streamSimple.',
			]);
			await expect(modelRegistry.refresh()).resolves.toBeUndefined();
		});

		it("pre-bind unregister removes all queued registrations for a provider", () => {
			const runtime = createExtensionRuntime();

			runtime.registerProvider("queued-provider", providerModelConfig);
			runtime.registerProvider("queued-provider", {
				...providerModelConfig,
				models: [
					{
						id: "instant-model-2",
						name: "Instant Model 2",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(runtime.pendingProviderRegistrations).toHaveLength(2);

			runtime.unregisterProvider("queued-provider");
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
		});

		it("post-bind register and unregister take effect immediately", () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);

			runner.bindCore(extensionActions, extensionContextActions);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);

			runtime.registerProvider("instant-provider", providerModelConfig);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
			expect(modelRegistry.find("instant-provider", "instant-model")?.cost.tiers).toEqual([
				{
					inputTokensAbove: 272000,
					input: 2,
					output: 3,
					cacheRead: 0.2,
					cacheWrite: 2.5,
				},
			]);

			runtime.unregisterProvider("instant-provider");
			expect(modelRegistry.find("instant-provider", "instant-model")).toBeUndefined();
		});
	});

	describe("command context", () => {
		it("passes fork options through to the bound handler", async () => {
			const runtime = createExtensionRuntime();
			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const fork = vi.fn(async () => ({ cancelled: false }));

			runner.bindCommandContext({
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: false }),
				fork,
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			});

			const commandContext = runner.createCommandContext();
			await commandContext.fork("entry-1");
			expect(fork).toHaveBeenCalledWith("entry-1", undefined);

			await commandContext.fork("entry-2", { position: "at" });
			expect(fork).toHaveBeenLastCalledWith("entry-2", { position: "at" });
		});
	});

	describe("hasHandlers", () => {
		it("returns true when handlers exist for event type", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async () => undefined);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "handler.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.hasHandlers("tool_call")).toBe(true);
			expect(runner.hasHandlers("agent_end")).toBe(false);
		});
	});

	describe("before_provider_headers", () => {
		it("lets a handler mutate headers in place and preserves existing headers", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("before_provider_headers", (event) => {
						event.headers["X-Turn-Index"] = "3";
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "headers.ts"), extCode);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

			expect(runner.hasHandlers("before_provider_headers")).toBe(true);

			const headers = await runner.emitBeforeProviderHeaders({ "User-Agent": "kimchi/1.0" });
			expect(headers["X-Turn-Index"]).toBe("3");
			expect(headers["User-Agent"]).toBe("kimchi/1.0");
		});

		it("isolates a throwing handler and still applies the others", async () => {
			const throwing = `
				export default function(pi) {
					pi.on("before_provider_headers", () => {
						throw new Error("header handler boom");
					});
				}
			`;
			const good = `
				export default function(pi) {
					pi.on("before_provider_headers", (event) => {
						event.headers["X-Good"] = "yes";
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "a-throwing.ts"), throwing);
			fs.writeFileSync(path.join(extensionsDir, "b-good.ts"), good);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const errors: Array<{ event: string; error: string }> = [];
			runner.onError((err) => errors.push(err));

			const headers = await runner.emitBeforeProviderHeaders({ "User-Agent": "x" });

			expect(headers["X-Good"]).toBe("yes");
			expect(headers["User-Agent"]).toBe("x");
			expect(errors).toHaveLength(1);
			expect(errors[0].event).toBe("before_provider_headers");
			expect(errors[0].error).toContain("header handler boom");
		});
	});

	describe("getRegisteredMcpServers", () => {
		it("returns declarations from all extensions with distinct names", async () => {
			const a = await loadExtensionFromFactory(
				(pi) => pi.registerMcpServer("alpha", { type: "stdio", command: "node", args: ["a.js"] }),
				tempDir,
				createEventBus(),
				createExtensionRuntime(),
				"<ext-a>",
			);
			const b = await loadExtensionFromFactory(
				(pi) => pi.registerMcpServer("beta", { type: "stdio", command: "node" }),
				tempDir,
				createEventBus(),
				createExtensionRuntime(),
				"<ext-b>",
			);
			const runner = new ExtensionRunner([a, b], createExtensionRuntime(), tempDir, sessionManager, modelRegistry);
			const servers = runner.getRegisteredMcpServers();
			expect(servers.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
			expect(servers.find((s) => s.name === "alpha")?.extensionPath).toBe("<ext-a>");
		});

		it("first extension wins on name collision and warns naming both paths", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const a = await loadExtensionFromFactory(
				(pi) => pi.registerMcpServer("dup", { type: "stdio", command: "first" }),
				tempDir,
				createEventBus(),
				createExtensionRuntime(),
				"<ext-a>",
			);
			const b = await loadExtensionFromFactory(
				(pi) => pi.registerMcpServer("dup", { type: "stdio", command: "second" }),
				tempDir,
				createEventBus(),
				createExtensionRuntime(),
				"<ext-b>",
			);
			const runner = new ExtensionRunner([a, b], createExtensionRuntime(), tempDir, sessionManager, modelRegistry);
			const servers = runner.getRegisteredMcpServers();
			expect(servers).toHaveLength(1);
			expect(servers[0]?.extensionPath).toBe("<ext-a>");
			expect(servers[0]?.config.command).toBe("first");
			const warning = warn.mock.calls.map((c) => c.join(" ")).find((t) => t.includes("dup"));
			expect(warning).toContain("<ext-a>");
			expect(warning).toContain("<ext-b>");
			warn.mockRestore();
		});

		it("returns an empty array when no extension declares MCP servers", () => {
			const runner = new ExtensionRunner([], createExtensionRuntime(), tempDir, sessionManager, modelRegistry);
			expect(runner.getRegisteredMcpServers()).toEqual([]);
		});

		it("exposes the aggregate via ExtensionContext in session_start handlers", async () => {
			let captured: ReturnType<typeof runner.getRegisteredMcpServers> | undefined;
			const a = await loadExtensionFromFactory(
				(pi) => pi.registerMcpServer("gamma", { type: "stdio", command: "node" }),
				tempDir,
				createEventBus(),
				createExtensionRuntime(),
				"<ext-a>",
			);
			const b = await loadExtensionFromFactory(
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						captured = ctx.getRegisteredMcpServers?.();
					});
				},
				tempDir,
				createEventBus(),
				createExtensionRuntime(),
				"<ext-b>",
			);
			const runner = new ExtensionRunner([a, b], createExtensionRuntime(), tempDir, sessionManager, modelRegistry);
			await runner.emit({ type: "session_start", reason: "startup" });
			expect(captured?.map((s) => s.name)).toEqual(["gamma"]);
		});
	});
});
