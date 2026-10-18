import { Editor, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { emitUserActivity } from "../../../src/core/extensions/user-activity.ts";
import { observeComposerActivity } from "../../../src/modes/interactive/composer-user-activity.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { cleanupPrewarmHarnesses, createPrewarmHarness } from "../prompt-cache-prewarm-harness.ts";

describe("only host user activity can prewarm (#3140)", () => {
	afterEach(() => {
		cleanupPrewarmHarnesses();
		vi.useRealTimers();
	});

	it("ignores extension pasteToEditor without terminal input", async () => {
		vi.useFakeTimers();
		initTheme("dark");
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm);
		const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme());
		observeComposerActivity(editor, () => emitUserActivity(harness.session, "draft"));
		const createUI: ((this: { editor: Editor }) => ExtensionUIContext) | undefined = Object.getOwnPropertyDescriptor(
			InteractiveMode.prototype,
			"createExtensionUIContext",
		)?.value;
		if (createUI === undefined) throw new Error("Missing UI factory");
		const ui = createUI.call({ editor });
		await harness.session.bindExtensions({});

		ui.pasteToEditor("extension-seeded draft");
		await vi.runAllTimersAsync();

		expect(editor.getText()).toBe("extension-seeded draft");
		expect(warm).not.toHaveBeenCalled();
	});

	it("ignores forged draft signals on the public extension bus", async () => {
		vi.useFakeTimers();
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm, {
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => pi.events.emit("user_activity", { kind: "draft" }));
				},
			],
		});

		await harness.session.bindExtensions({});
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});
});
