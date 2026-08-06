import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("user abort racing a TTSR system abort", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("promotes the joined abort to user and cancels remediation", async () => {
		const abortSources: Array<string | undefined> = [];
		let sessionAbortCount = 0;
		let terminalInput: ((data: string) => void) | undefined;
		let signalSystemAbort: (() => void) | undefined;
		const systemAbortStarted = new Promise<void>((resolve) => {
			signalSystemAbort = resolve;
		});
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				goalExtension,
				ttsrExtension,
				(pi) => {
					pi.on("session_start", () => {
						pi.events?.emit("terminal_monitor_state", { activeCount: 1 });
					});
					pi.on("agent_end", (event) => {
						abortSources.push(event.abortSource);
					});
					pi.on("session_abort", () => {
						sessionAbortCount += 1;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createUi((handler) => {
				terminalInput = handler;
			}),
		});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Keep the user in control");
		const originalAbort = harness.agent.abort.bind(harness.agent);
		const abortSpy = vi.spyOn(harness.agent, "abort").mockImplementation(() => {
			signalSystemAbort?.();
			originalAbort();
		});
		harness.setResponses([fauxAssistantMessage([fauxText('<unavailable-tool-call name="read"> inert imitation')])]);

		const prompt = harness.session.prompt("continue monitoring");
		await systemAbortStarted;
		terminalInput?.("\u001b");
		await harness.session.abort();
		await prompt;

		expect(abortSpy).toHaveBeenCalledTimes(1);
		expect(abortSources).toContain("user");
		expect(abortSources).not.toContain("system");
		expect(sessionAbortCount).toBe(0);
		expect(await readGoal(ref)).toMatchObject({ status: "blocked", blockedReason: "user interrupted the turn" });
		expect(harness.faux.getCallLog()).toHaveLength(1);
	});

	it("aborts each consecutive TTSR recovery generation with system provenance", async () => {
		const abortSources: Array<string | undefined> = [];
		const scheduledContinuations: unknown[] = [];
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [
				goalExtension,
				ttsrExtension,
				(pi) => {
					pi.on("session_start", () => {
						pi.events?.emit("terminal_monitor_state", { activeCount: 1 });
					});
					pi.on("agent_end", (event) => {
						abortSources.push(event.abortSource);
					});
					pi.events?.on("goal_continuation_scheduled", (data) => {
						scheduledContinuations.push(data);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const ref = goalStoreRef(harness.sessionManager, harness.tempDir);
		await createGoal(ref, "Keep the monitor live through repeated remediation");
		const originalAbort = harness.agent.abort.bind(harness.agent);
		const abortSpy = vi.spyOn(harness.agent, "abort").mockImplementation(() => {
			originalAbort();
		});
		const leaked = ["<", "|", "sep", "|", ">"].join("");
		harness.setResponses([
			fauxAssistantMessage([fauxThinking(`Thinking... ${leaked} ${leaked} ${leaked} trailing ${"x".repeat(400)}`)]),
			fauxAssistantMessage([fauxThinking(`Retrying with collapsed output ${"!".repeat(800)}`)]),
			fauxAssistantMessage([fauxText("clean recovery")]),
		]);

		await harness.session.prompt("continue monitoring");

		expect(abortSources).toEqual(["system", "system", undefined]);
		expect(abortSpy).toHaveBeenCalledTimes(2);
		expect(await readGoal(ref)).toMatchObject({ status: "active" });
		expect(scheduledContinuations).toContainEqual(
			expect.objectContaining({ activeMonitorCount: 1, delayMs: 240_000 }),
		);
	});
});

function createUi(captureInput: (handler: (data: string) => void) => void): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: (handler) => {
			captureInput(handler);
			return () => {};
		},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>(): Promise<T> => {
			throw new Error("Race test does not render custom UI");
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
