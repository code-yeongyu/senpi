import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import btwExtension, { clearBtwSessionActionReservationsForTest } from "../../src/core/extensions/builtin/btw/index.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";

afterEach(() => {
	setKittyProtocolActive(false);
	clearBtwSessionActionReservationsForTest();
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
		});
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
		expect(mainSend).toHaveBeenCalledWith("/btw", { expandPromptTemplates: true });
		expect(closeDisposition).toEqual({ consume: true });
		expect(sideSend).not.toHaveBeenCalled();
	});
});
