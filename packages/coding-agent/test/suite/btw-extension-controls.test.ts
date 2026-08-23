import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import btwExtension from "../../src/core/extensions/builtin/btw/index.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";

afterEach(() => {
	setKittyProtocolActive(false);
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
		expect(sendUserMessage).toHaveBeenCalledWith("/btw", {
			expandPromptTemplates: true,
		});
	});
});
