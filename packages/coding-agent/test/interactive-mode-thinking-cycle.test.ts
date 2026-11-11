import { Container, Text, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Shift+Tab thinking-cycle on the local session.
 *
 * `session.cycleThinkingLevel()` returns the new level synchronously, or
 * undefined when the model does not support thinking. The handler only uses
 * that value for the unsupported-model status; the footer and editor color
 * are updated by the `thinking_level_changed` session event.
 */

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type MockFn = ReturnType<typeof vi.fn>;

interface CycleContext {
	isInitialized: boolean;
	session: {
		cycleThinkingLevel: () => unknown;
		thinkingLevel?: string;
	};
	footer: { invalidate: MockFn };
	ui: { requestRender: MockFn };
	showStatus: MockFn;
	updateEditorBorderColor: MockFn;
}

interface ModePrototype {
	cycleThinkingLevel(this: CycleContext): unknown;
	handleEvent(this: CycleContext, event: { type: string; level?: string }): unknown;
}

const proto = InteractiveMode.prototype as unknown as ModePrototype;

function createContext(cycleResult: unknown): CycleContext {
	return {
		isInitialized: false,
		session: {
			cycleThinkingLevel: vi.fn(() => cycleResult),
			thinkingLevel: "medium",
		},
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	};
}

async function flushMicrotasks(turns = 20): Promise<void> {
	for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

describe("interactive thinking level cycle", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps the sync local-session path free of [object Promise] and unsupported false negatives", async () => {
		const context = createContext("xhigh");
		await proto.cycleThinkingLevel.call(context);
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses.every((status) => !status.includes("[object Promise]"))).toBe(true);
		expect(statuses).not.toContain("Current model does not support thinking");
	});

	it("reports unsupported models when the cycle returns undefined", async () => {
		const context = createContext(undefined);
		await proto.cycleThinkingLevel.call(context);
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses).toContain("Current model does not support thinking");
	});

	it("updates the footer and editor without adding a transcript status", async () => {
		const context = createContext("high");
		context.isInitialized = true;
		await proto.handleEvent.call(context, { type: "thinking_level_changed", level: "high" });
		await flushMicrotasks();
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.footer.invalidate).toHaveBeenCalled();
		expect(context.updateEditorBorderColor).toHaveBeenCalled();
	});

	it.each([12, 24, 60])("keeps thinking-level render diffs below the transcript at %i rows", async (rows) => {
		const writes: string[] = [];
		const terminal = new VirtualTerminal(80, rows);
		const write = terminal.write.bind(terminal);
		terminal.write = (bytes) => {
			writes.push(bytes);
			write(bytes);
		};
		const ui = new TUI(terminal);
		const chatContainer = new Container();
		const startup = [
			"Optimized system prompt applied: test-model",
			"Tip: test tip",
			"[Context]",
			"[Skills]",
			"[Extensions]",
			"Context size limits",
			"Settings: settings.json (JSON)",
			...Array.from({ length: 20 }, (_, index) => `startup notice ${index}`),
		];
		chatContainer.addChild(new Text(startup.join("\n"), 0, 0));
		const footer = new Text("effort medium (shift+tab)", 0, 0);
		ui.addChild(chatContainer);
		ui.addChild(new Text("> editor", 0, 0));
		ui.addChild(footer);
		const statusHost = { chatContainer, ui };
		const showStatus = Reflect.get(InteractiveMode.prototype, "showStatus") as (
			this: typeof statusHost,
			message: string,
		) => void;
		const context = {
			...createContext("high"),
			isInitialized: true,
			ui,
			showStatus: vi.fn((message: string) => showStatus.call(statusHost, message)),
			updateEditorBorderColor: vi.fn(() => ui.requestRender()),
		};
		ui.start();
		try {
			ui.renderNow();
			await terminal.flush();
			const transcript = chatContainer.render(80);
			const viewport = terminal.getViewport();
			const footerRow = viewport.findIndex((line) => line.includes("effort medium (shift+tab)"));
			expect(footerRow).toBeGreaterThanOrEqual(0);
			for (const level of ["high", "xhigh", "minimal", "medium"]) {
				writes.length = 0;
				footer.setText(`effort ${level} (shift+tab)`);
				await proto.handleEvent.call(context as unknown as CycleContext, { type: "thinking_level_changed", level });
				ui.renderNow();
				await terminal.flush();
				const output = writes.join("");
				expect(output).toContain(`effort ${level} (shift+tab)`);
				expect(output).not.toContain("Thinking level:");
				expect(output).not.toMatch(/\x1b\[(?:[23]J|[0-9]+;[0-9]+r)/);
				for (const line of startup) expect(output).not.toContain(line);
				expect(chatContainer.render(80)).toEqual(transcript);
				expect(terminal.getViewport().filter((_, row) => row !== footerRow)).toEqual(
					viewport.filter((_, row) => row !== footerRow),
				);
			}
		} finally {
			ui.stop();
		}
	});
});
