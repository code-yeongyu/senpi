import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getKeybindings, SelectList, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme, defaultSelectListTheme } from "../../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getUserTexts, type Harness } from "../harness.ts";
import { createFakeInteractiveMode } from "../helpers/ask-user-async-fake-mode.ts";

const harnesses: Harness[] = [];
const tuis: TuiMainScreen[] = [];
const originalKeybindings = getKeybindings();
afterEach(() => {
	for (const tui of tuis.splice(0)) tui.stop();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
	setKeybindings(originalKeybindings);
});

async function parkedSession() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	initTheme("dark");
	const timerStates: unknown[] = [];
	const goalUi = { changed: () => {} };
	const harness = await createHarness({
		persistSession: true,
		extensionFactories: [
			goalExtension,
			(pi) => {
				pi.on("session_start", () => {
					pi.events.emit("terminal_monitor_state", { activeCount: 1 });
				});
				pi.events.on("goal_continuation_timer_state", (state) => timerStates.push(state));
			},
		],
	});
	harnesses.push(harness);
	const terminal = new VirtualTerminal(120, 34);
	const ui = new TuiMainScreen(terminal);
	const editor = new CustomEditor(ui, defaultEditorTheme, keybindings);
	const host = createFakeInteractiveMode();
	Object.assign(host, {
		ui,
		editor,
		defaultEditor: editor,
		keybindings,
		runtimeHost: { session: harness.session },
		extensionTerminalInputSubscriptions: new Set(),
		extensionIdleEscapeHandlers: new Set(),
		pendingImages: new Map(),
		isBashMode: false,
		lastEscapeTime: 0,
		updateShortcutOverlay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	});
	host.editorContainer.clear();
	host.editorContainer.addChild(editor);
	ui.addChild(host.editorContainer);
	ui.setFocus(editor);
	(Reflect.get(host, "setupKeyHandlers") as () => void).call(host);
	ui.start();
	tuis.push(ui);
	const notify = vi.fn();
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: {
			...host.createExtensionUIContext(),
			notify,
			setStatus: (key) => {
				if (key === "goal") goalUi.changed();
			},
		},
	});
	const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
	await createGoal(ref, "Wait for the monitored work");
	harness.setResponses([fauxAssistantMessage("Waiting for the event.")]);
	await harness.session.prompt("Monitor the work", { source: "extension" });
	expect(timerStates.at(-1)).toMatchObject({ armed: true, kind: "monitor" });
	expect(harness.session.isIdle).toBe(true);
	return { harness, ref, timerStates, terminal, ui, goalUi, notify };
}

// senpi#4050: exercise the real session, TUI dispatch, editor, and host Escape chain.
describe("input during a parked goal wait", () => {
	it.each(["tui", "rpc", "print"] as const)("starts a %s host without idle-Escape capability", async (mode) => {
		const ui = createTestUiContext();
		Reflect.deleteProperty(ui, "onTerminalInput");
		Reflect.deleteProperty(ui, "onIdleEscape");
		const harness = await createHarness({ persistSession: true, extensionFactories: [goalExtension] });
		harnesses.push(harness);
		const errors: unknown[] = [];

		await harness.session.bindExtensions({ mode, uiContext: ui, onError: (error) => errors.push(error) });

		expect(errors).toEqual([]);
		expect(harness.session.isIdle).toBe(true);
	});

	it("delivers new user input with steer semantics immediately and cancels the old wait", async () => {
		const { harness, timerStates } = await parkedSession();
		harness.setResponses([fauxAssistantMessage("Handled the user's request.")]);

		await harness.session.prompt("Change direction now", { streamingBehavior: "steer" });

		expect(getUserTexts(harness).filter((text) => text === "Change direction now")).toHaveLength(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(timerStates).toContainEqual({ armed: false, kind: "monitor" });
		expect(harness.session.isIdle).toBe(true);
		expect(harness.faux.getCallLog()).toHaveLength(2);
	});

	it("cancels the parked wait on keyboard Escape without starting a model turn", async () => {
		const { harness, timerStates, terminal, ref, goalUi, notify } = await parkedSession();
		const updated = Promise.withResolvers<void>();
		goalUi.changed = updated.resolve;

		terminal.sendInput("\u001b");

		expect(timerStates.at(-1)).toMatchObject({ armed: false, kind: "monitor" });
		await updated.promise;
		expect(await readGoal(ref)).toMatchObject({ status: "blocked" });
		await vi.advanceTimersByTimeAsync(271_000);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/goal resume"), "info");
	});

	it("closes a focused picker without cancelling the parked wait", async () => {
		const { terminal, ui, timerStates, ref, goalUi } = await parkedSession();
		const updated = Promise.withResolvers<void>();
		goalUi.changed = updated.resolve;
		const picker = new SelectList([{ value: "one", label: "One" }], 5, defaultSelectListTheme);
		let cancelled = false;
		picker.onCancel = () => {
			cancelled = true;
			ui.hideOverlay();
		};
		ui.showOverlay(picker);

		terminal.sendInput("\u001b");
		if (!cancelled) await updated.promise;

		expect(cancelled).toBe(true);
		expect(timerStates.at(-1)).toMatchObject({ armed: true, kind: "monitor" });
		expect(await readGoal(ref)).toMatchObject({ status: "active" });
	});

	it("leaves the user-grace countdown to its existing controls", async () => {
		const { harness, terminal, timerStates, goalUi } = await parkedSession();
		harness.setResponses([fauxAssistantMessage("The user's update is handled.")]);
		await harness.session.prompt("One more instruction", { source: "interactive" });
		expect(timerStates.at(-1)).toMatchObject({ armed: true, kind: "userGrace" });
		const updated = Promise.withResolvers<void>();
		goalUi.changed = updated.resolve;

		terminal.sendInput("\u001b");
		if ((timerStates.at(-1) as { armed: boolean }).armed === false) await updated.promise;

		expect(timerStates.at(-1)).toMatchObject({ armed: true, kind: "userGrace" });
	});
});
