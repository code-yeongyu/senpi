import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import btwExtension, { clearBtwSessionActionReservationsForTest } from "../../src/core/extensions/builtin/btw/index.ts";
import { defaultBtwTuiCommandDependencies } from "../../src/core/extensions/builtin/btw/tui-command.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";

afterEach(() => {
	setKittyProtocolActive(false);
	clearBtwSessionActionReservationsForTest();
	vi.restoreAllMocks();
});

describe("BTW extension TUI controls", () => {
	it("dispatches the picker command from the configured Ctrl+7 terminal input", async () => {
		// Given
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const sendUserMessage = vi.fn();
		const registerCommand = vi.fn();
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			}),
			registerCommand,
			sendUserMessage,
			setActiveTools: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
		} as unknown as ExtensionAPI;
		btwExtension(pi);
		const keybindings = new KeybindingsManager();
		let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const ctx = {
			mode: "tui",
			isIdle: () => true,
			resolveOwnCommandInvocationName: (name: string) => (name === "btw" ? "btw:2" : undefined),
			sessionManager: {
				getEntries: () => [],
				getSessionFile: () => "/sessions/main.jsonl",
			},
			ui: {
				matchesKeybinding: (data: string, binding: Parameters<KeybindingsManager["matches"]>[1]) =>
					keybindings.matches(data, binding),
				onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
					terminalHandler = handler;
					return () => undefined;
				},
			},
		} as unknown as ExtensionContext;
		setKittyProtocolActive(true);
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, ctx);

		// When
		const disposition = terminalHandler?.("\x1b[55;5u");

		// Then
		expect(disposition).toEqual({ consume: true });
		expect(sendUserMessage).toHaveBeenCalledWith("/btw:2", {
			expandPromptTemplates: true,
			onRejected: expect.any(Function),
		});
	});

	it("releases a shortcut reservation when host dispatch rejects before command execution", () => {
		// Given
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const sendUserMessage = vi.fn(
			(
				_message: string,
				options?: {
					onRejected?: () => void;
				},
			) => {
				options?.onRejected?.();
			},
		);
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			}),
			registerCommand: vi.fn(),
			sendUserMessage,
			setActiveTools: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
		} as unknown as ExtensionAPI;
		btwExtension(pi);
		let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const ctx = {
			mode: "tui",
			isIdle: () => true,
			resolveOwnCommandInvocationName: (name: string) => name,
			sessionManager: { getEntries: () => [], getSessionFile: () => "/sessions/main.jsonl" },
			ui: {
				matchesKeybinding: (data: string, binding: Parameters<KeybindingsManager["matches"]>[1]) =>
					data === "\x1f" && binding === "app.btw.switch",
				onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
					terminalHandler = handler;
					return () => undefined;
				},
			},
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, ctx);

		// When
		const firstDisposition = terminalHandler?.("\x1f");
		const secondDisposition = terminalHandler?.("\x1f");

		// Then
		expect(firstDisposition).toEqual({ consume: true });
		expect(secondDisposition).toEqual({ consume: true });
		expect(sendUserMessage).toHaveBeenCalledTimes(2);
	});

	it("dispatches one close command for repeated raw Ctrl+C while close is pending", () => {
		// Given
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const sendUserMessage = vi.fn();
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			}),
			registerCommand: vi.fn(),
			sendUserMessage,
			setActiveTools: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
		} as unknown as ExtensionAPI;
		btwExtension(pi);
		let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const ctx = {
			mode: "tui",
			isIdle: () => true,
			resolveOwnCommandInvocationName: (name: string) => name,
			sessionManager: {
				getSessionId: () => "side",
				getLeafId: () => "side-leaf",
				getSessionDir: () => "/sessions",
				getSessionFile: () => "/sessions/side.jsonl",
				getEntries: () => [
					{
						type: "custom",
						customType: "btw-side",
						data: {
							version: 1,
							parentSessionPath: "/sessions/main.jsonl",
							parentSessionId: "main",
							ordinal: 1,
							summary: "side",
							createdAt: "2026-08-23T00:00:00.000Z",
						},
					},
				],
			},
			ui: {
				matchesKeybinding: (data: string, binding: Parameters<KeybindingsManager["matches"]>[1]) =>
					data === "\x03" && binding === "app.clear",
				onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
					terminalHandler = handler;
					return () => undefined;
				},
			},
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, ctx);

		// When
		const first = terminalHandler?.("\x03");
		const second = terminalHandler?.("\x03");

		// Then
		expect(first).toEqual({ consume: true });
		expect(second).toEqual({ consume: true });
		expect(sendUserMessage).toHaveBeenCalledOnce();
		expect(sendUserMessage).toHaveBeenCalledWith("/btw-close", {
			expandPromptTemplates: true,
			onRejected: expect.any(Function),
		});
	});

	it("blocks destructive close while a switch command is pending", () => {
		// Given
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const sendUserMessage = vi.fn();
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			}),
			registerCommand: vi.fn(),
			sendUserMessage,
			setActiveTools: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
		} as unknown as ExtensionAPI;
		btwExtension(pi);
		let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const ctx = {
			mode: "tui",
			isIdle: () => true,
			resolveOwnCommandInvocationName: (name: string) => name,
			sessionManager: {
				getSessionId: () => "side",
				getLeafId: () => "side-leaf",
				getSessionDir: () => "/sessions",
				getSessionFile: () => "/sessions/side.jsonl",
				getEntries: () => [
					{
						type: "custom",
						customType: "btw-side",
						data: {
							version: 1,
							parentSessionPath: "/sessions/main.jsonl",
							parentSessionId: "main",
							ordinal: 1,
							summary: "side",
							createdAt: "2026-08-23T00:00:00.000Z",
						},
					},
				],
			},
			ui: {
				matchesKeybinding: (data: string, binding: Parameters<KeybindingsManager["matches"]>[1]) =>
					(data === "switch" && binding === "app.btw.switch") ||
					(data === "close" && binding === "app.clear") ||
					(data === "escape" && binding === "app.interrupt"),
				onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
					terminalHandler = handler;
					return () => undefined;
				},
			},
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, ctx);

		// When
		const switchDisposition = terminalHandler?.("switch");
		const closeDisposition = terminalHandler?.("close");
		const firstEscape = terminalHandler?.("escape");
		const secondEscape = terminalHandler?.("escape");

		// Then
		expect(switchDisposition).toEqual({ consume: true });
		expect(closeDisposition).toEqual({ consume: true });
		expect(firstEscape).toBeUndefined();
		expect(secondEscape).toEqual({ consume: true });
		expect(sendUserMessage).toHaveBeenCalledOnce();
		expect(sendUserMessage).toHaveBeenCalledWith("/btw", {
			expandPromptTemplates: true,
			onRejected: expect.any(Function),
		});
	});

	it("carries a pending switch reservation into the rebound side generation", () => {
		// Given
		const mainHandlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const mainSend = vi.fn();
		btwExtension({
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				mainHandlers.set(event, handler);
			}),
			registerCommand: vi.fn(),
			sendUserMessage: mainSend,
			setActiveTools: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
		} as unknown as ExtensionAPI);
		let mainTerminal: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const mainCtx = {
			mode: "tui",
			isIdle: () => true,
			resolveOwnCommandInvocationName: (name: string) => name,
			sessionManager: {
				getSessionId: () => "main",
				getLeafId: () => "main-leaf",
				getSessionDir: () => "/sessions",
				getSessionFile: () => "/sessions/main.jsonl",
				getEntries: () => [],
			},
			ui: {
				matchesKeybinding: (data: string, binding: Parameters<KeybindingsManager["matches"]>[1]) =>
					data === "switch" && binding === "app.btw.switch",
				onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
					mainTerminal = handler;
					return () => undefined;
				},
			},
		} as unknown as ExtensionContext;
		mainHandlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			mainCtx,
		);
		mainTerminal?.("switch");

		const sideHandlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const sideSend = vi.fn();
		btwExtension({
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				sideHandlers.set(event, handler);
			}),
			registerCommand: vi.fn(),
			sendUserMessage: sideSend,
			setActiveTools: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
		} as unknown as ExtensionAPI);
		let sideTerminal: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const sideCtx = {
			mode: "tui",
			isIdle: () => false,
			resolveOwnCommandInvocationName: (name: string) => name,
			sessionManager: {
				getSessionId: () => "side",
				getLeafId: () => "side-leaf",
				getSessionDir: () => "/sessions",
				getSessionFile: () => "/sessions/side.jsonl",
				getEntries: () => [
					{
						type: "custom",
						customType: "btw-side",
						data: {
							version: 1,
							parentSessionPath: "/sessions/main.jsonl",
							parentSessionId: "main",
							ordinal: 1,
							summary: "side",
							createdAt: "2026-08-23T00:00:00.000Z",
						},
					},
				],
			},
			ui: {
				matchesKeybinding: (data: string, binding: Parameters<KeybindingsManager["matches"]>[1]) =>
					data === "close" && binding === "app.clear",
				onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
					sideTerminal = handler;
					return () => undefined;
				},
			},
		} as unknown as ExtensionContext;
		sideHandlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } satisfies SessionStartEvent,
			sideCtx,
		);

		// When
		const closeDisposition = sideTerminal?.("close");

		// Then
		expect(mainSend).toHaveBeenCalledWith("/btw", {
			expandPromptTemplates: true,
			onRejected: expect.any(Function),
		});
		expect(closeDisposition).toEqual({ consume: true });
		expect(sideSend).not.toHaveBeenCalled();
	});

	it("releases the switch reservation once the retained initial turn starts", async () => {
		// Given
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		let sideCtx: ExtensionContext;
		let closePromise: Promise<void> | undefined;
		const sendUserMessage = vi.fn((message: string) => {
			if (message === "/btw-close") {
				closePromise = commands.get("btw-close")?.handler("", sideCtx);
			}
		});
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			}),
			registerCommand: vi.fn(
				(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
					commands.set(name, command);
				},
			),
			sendUserMessage,
			setActiveTools: vi.fn(),
			getThinkingLevel: vi.fn(() => "off"),
		} as unknown as ExtensionAPI;
		btwExtension(pi);
		let releaseInitialTurn: (() => void) | undefined;
		const initialTurn = new Promise<void>((resolve) => {
			releaseInitialTurn = resolve;
		});
		let markInitialTurnStarted: (() => void) | undefined;
		const initialTurnStarted = new Promise<void>((resolve) => {
			markInitialTurnStarted = resolve;
		});
		vi.spyOn(defaultBtwTuiCommandDependencies, "sessionExists").mockResolvedValue(true);
		vi.spyOn(defaultBtwTuiCommandDependencies, "loadCatalog").mockResolvedValue({
			parentSessionPath: "/sessions/main.jsonl",
			main: {
				id: "main",
				path: "/sessions/main.jsonl",
				cwd: "/repo",
				name: "Main",
				modified: new Date("2026-08-23T00:00:00.000Z"),
			},
			currentSide: undefined,
			sides: [],
			skippedPaths: [],
		});
		vi.spyOn(defaultBtwTuiCommandDependencies, "createSide").mockImplementation(async (input) => {
			(
				input as typeof input & {
					onInitialTurnStarted?: () => void;
				}
			).onInitialTurnStarted?.();
			markInitialTurnStarted?.();
			await initialTurn;
		});
		const notify = vi.fn();
		const mainCtx = {
			mode: "tui",
			hasUI: true,
			waitForIdle: vi.fn(async () => undefined),
			sessionManager: {
				getSessionId: () => "main",
				getLeafId: () => "main-leaf",
				getSessionFile: () => "/sessions/main.jsonl",
				getEntries: () => [],
			},
			ui: { notify },
		} as unknown as ExtensionContext;
		const btwPromise = commands.get("btw")?.handler("slow question", mainCtx);
		await initialTurnStarted;

		let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		const sideSwitch = vi.fn(
			async (
				_sessionPath: string,
				options?: {
					withSession?: (ctx: ExtensionContext) => Promise<void>;
				},
			) => {
				await options?.withSession?.({
					inspectSessionMetadata: (sessionPath: string) => ({
						id: sessionPath === "/sessions/side.jsonl" ? "replacement-side" : "main",
					}),
					navigateTree: vi.fn(async () => ({ cancelled: false })),
					ui: { notify },
				} as unknown as ExtensionContext);
				return { cancelled: false };
			},
		);
		sideCtx = {
			mode: "tui",
			isIdle: () => false,
			getSourceActivityGeneration: () => 1,
			resolveOwnCommandInvocationName: (name: string) => name,
			inspectSessionMetadata: (sessionPath: string) => ({
				id: sessionPath === "/sessions/main.jsonl" ? "main" : "side",
			}),
			switchSession: sideSwitch,
			sessionManager: {
				getSessionId: () => "side",
				getLeafId: () => "side-leaf",
				getSessionDir: () => "/sessions",
				getSessionFile: () => "/sessions/side.jsonl",
				getEntries: () => [
					{
						type: "custom",
						customType: "btw-side",
						data: {
							version: 1,
							parentSessionPath: "/sessions/main.jsonl",
							parentSessionId: "main",
							ordinal: 1,
							summary: "slow question",
							createdAt: "2026-08-23T00:00:00.000Z",
						},
					},
				],
			},
			ui: {
				matchesKeybinding: (data: string, binding: Parameters<KeybindingsManager["matches"]>[1]) =>
					data === "\x03" && binding === "app.clear",
				onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
					terminalHandler = handler;
					return () => undefined;
				},
				notify,
			},
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({ type: "session_start", reason: "resume" } satisfies SessionStartEvent, sideCtx);

		// When
		const disposition = terminalHandler?.("\x03");
		releaseInitialTurn?.();
		await btwPromise;
		await closePromise;

		// Then
		expect(disposition).toEqual({ consume: true });
		expect(sendUserMessage).toHaveBeenCalledWith("/btw-close", {
			expandPromptTemplates: true,
			onRejected: expect.any(Function),
		});
		expect(sideSwitch).toHaveBeenCalledOnce();
	});
});
