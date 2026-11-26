import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	resetMainScreenHistoryLines,
	type Terminal,
	Text,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { ExplorationTranscriptContainer } from "../../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import type { ToolRenderers } from "../../../src/modes/interactive/components/tool-execution-types.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const CARDS = 120 as const;
const OUTPUT_LINES = 12 as const;
const SHELL = 4 as const;

class RecordingTerminal implements Terminal {
	columns = 100;
	rows = 20;
	kittyProtocolActive = true;
	writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

const fakeUi = { requestRender: () => {} } as TUI;

function finishedBashCard(index: number): ToolExecutionComponent {
	const card = new ToolExecutionComponent(
		"bash",
		`call-${index}`,
		{ command: `run ${index}` },
		{},
		undefined,
		fakeUi,
		process.cwd(),
	);
	const text = Array.from({ length: OUTPUT_LINES }, (_, line) => `card ${index} output line ${line}`).join("\n");
	card.updateResult({ content: [{ type: "text", text }], isError: false }, false);
	return card;
}

/** Components the card still holds under it; a released card keeps only its empty shell. */
function descendants(component: Component): number {
	const children: unknown = Reflect.get(component, "children");
	if (!Array.isArray(children)) return 0;
	return children.reduce((total: number, child: Component) => total + 1 + descendants(child), 0);
}

function assistantReply(index: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `reply ${index}` }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** Lines an assistant message holds in its private render cache (0 when it holds none). */
function retainedRenderLines(reply: AssistantMessageComponent): number {
	const cache: unknown = Reflect.get(reply, "renderCache");
	const lines: unknown = cache === undefined ? undefined : Reflect.get(cache as object, "lines");
	return Array.isArray(lines) ? lines.length : 0;
}

/** Resolves on the transcript's next render request (hydration publishing its warmed head), or fails after 5 s. */
function nextRenderRequest(transcript: { onRequestRender: (() => void) | undefined }): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no render request within 5 s")), 5000);
		transcript.onRequestRender = () => {
			clearTimeout(timer);
			transcript.onRequestRender = undefined;
			resolve();
		};
	});
}

let previousHistoryLines: string | undefined;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	previousHistoryLines = process.env.PI_TUI_HISTORY_LINES;
	process.env.PI_TUI_HISTORY_LINES = "60";
	resetMainScreenHistoryLines();
});

afterEach(() => {
	if (previousHistoryLines === undefined) delete process.env.PI_TUI_HISTORY_LINES;
	else process.env.PI_TUI_HISTORY_LINES = previousHistoryLines;
	resetMainScreenHistoryLines();
});

describe("tool cards above the kept main-screen history (#2537)", () => {
	it("drop their built output once they leave the kept window, and paint it again in fullscreen", async () => {
		// Given: a long regular-mode run of assistant replies and finished tool cards, painted one by one
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const signal: { onRequestRender: (() => void) | undefined } = { onRequestRender: undefined };
		const transcript = new ExplorationTranscriptContainer({
			tailBudget: 60,
			warmChunkSize: 100,
			requestRender: () => signal.onRequestRender?.(),
		});
		tui.addChild(transcript);
		tui.start();
		const cards: ToolExecutionComponent[] = [];
		const firstReply = new AssistantMessageComponent(assistantReply(0));
		let lastReply = firstReply;
		for (let index = 0; index < CARDS; index++) {
			if (index > 0) lastReply = new AssistantMessageComponent(assistantReply(index));
			transcript.addChild(lastReply);
			const card = finishedBashCard(index);
			cards.push(card);
			transcript.addChild(card);
			tui.renderNow();
		}

		// Then: the first card scrolled far above the window holds no built output, the last one does
		const first = cards[0]!;
		const last = cards.at(-1)!;
		// A card's shell is a spacer, its renderer, its image strip and the renderer's content box.
		expect(descendants(last)).toBeGreaterThan(SHELL);
		expect(descendants(first)).toBe(SHELL);
		// And: the reply above the window keeps no rendered lines, while the newest reply still does
		expect(retainedRenderLines(firstReply)).toBe(0);
		expect(retainedRenderLines(lastReply)).toBeGreaterThan(0);

		// When: the whole tree is invalidated, as a theme or terminal-capability change does
		tui.invalidate();
		tui.renderNow();

		// Then: the card above the window still holds only its shell; the painted last card is rebuilt
		expect(descendants(first)).toBe(SHELL);
		expect(descendants(last)).toBeGreaterThan(SHELL);
		tui.stop();

		// When: the user switches to fullscreen, which shows the whole transcript
		const fullscreen = new TuiAltScreen(new RecordingTerminal(), false);
		fullscreen.addChild(transcript);
		fullscreen.start();
		const warmed = nextRenderRequest(signal);
		fullscreen.renderNow();
		await warmed;
		const document = transcript.render(terminal.columns).join("\n");

		// Then: the released card paints exactly what a card that was never released paints, in order
		const expected = finishedBashCard(0).render(terminal.columns).join("\n");
		expect(document).toContain(expected);
		expect(document.indexOf(expected)).toBeLessThan(document.indexOf("run 1"));
		fullscreen.stop();
	});

	it("keeps a renderer's own component across its context.invalidate(), so async data it cached shows", async () => {
		// Given: an extension renderer that loads once, caches the result on its component, then asks for a rerender
		let loads = 0;
		const loaded: { resolve: () => void } = { resolve: () => {} };
		const shown = new Promise<void>((resolve) => {
			loaded.resolve = resolve;
		});
		const toolDefinition: ToolRenderers = {
			renderCall: (_args, _theme, context) => {
				const previous = context.lastComponent;
				if (previous instanceof Text && Reflect.get(previous, "data") !== undefined) return previous;
				const component = previous instanceof Text ? previous : new Text("loading...", 0, 0);
				if (Reflect.get(component, "loading") !== true) {
					Reflect.set(component, "loading", true);
					loads++;
					queueMicrotask(() => {
						Reflect.set(component, "data", "loaded data");
						component.setText("loaded data");
						context.invalidate();
						loaded.resolve();
					});
				}
				return component;
			},
		};
		const card = new ToolExecutionComponent("custom_tool", "custom-1", {}, {}, toolDefinition, fakeUi, process.cwd());
		card.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		card.render(100);

		// When: the async load lands and the renderer invalidates its row
		await shown;

		// Then: it loaded once and the card shows the data
		expect(card.render(100).join("\n")).toContain("loaded data");
		expect(loads).toBe(1);
	});

	it("stays released when every card is expanded, and paints expanded when shown again", () => {
		// Given: a finished card whose built output was released
		const card = finishedBashCard(0);
		card.render(100);
		card.invalidate();
		expect(descendants(card)).toBe(SHELL);

		// When: expand-all reaches it
		card.setExpanded(true);

		// Then: it still holds only its shell until it is painted, and then paints the expanded output
		expect(descendants(card)).toBe(SHELL);
		const expanded = finishedBashCard(1);
		expanded.setExpanded(true);
		expect(card.render(100).length).toBe(expanded.render(100).length);
		expect(descendants(card)).toBeGreaterThan(SHELL);
	});
});
