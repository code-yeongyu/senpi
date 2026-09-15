import { setKeybindings, TuiAltScreen, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { AskUserAsyncWidget } from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const request: QuestionRequest = {
	requestId: "mouse-widget",
	waitForAnswer: false,
	timeoutMs: 0,
	questions: [
		{
			id: "auth",
			header: "Auth",
			question: "Choose authentication",
			multiSelect: false,
			options: [
				{ label: "OAuth" },
				{ label: "API key" },
				{ label: "Service account with a very long descriptive label" },
			],
		},
	],
};
function setup() {
	const options = {
		request,
		draft: { answers: {} },
		timeoutMs: 0,
		pendingCount: 2,
		mouseCaptureActive: true,
		onExpire: vi.fn(),
		onOptionClick: vi.fn(),
		onOwnAnswerClick: vi.fn(),
		onExpandClick: vi.fn(),
		onNextQuestion: vi.fn(),
	};
	return { widget: new AskUserAsyncWidget(options), ...options };
}
function mouse(type: TuiMouseEvent["type"], x: number, y: number, width = 120, clickCount = 1): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height: 34,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount,
	};
}
function buttons(lines: string[]) {
	return lines.flatMap((line, row) =>
		[...line.matchAll(/\[ [^\]]* \]/g)].map((match) => ({
			row,
			start: visibleWidth(line.slice(0, match.index)),
			end: visibleWidth(line.slice(0, match.index + match[0].length)),
			text: match[0],
		})),
	);
}
function plain(lines: string[]): string[] {
	return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
describe("pending widget mouse (#1645)", () => {
	it("claims an option press before activating it", () => {
		const { widget, onOptionClick } = setup();
		try {
			widget.render(120);
			expect(widget.handleMouse(mouse("press", 4, 2))).toEqual({ handled: true });
			expect(onOptionClick).not.toHaveBeenCalled();
			widget.handleMouse(mouse("click", 4, 2));
			expect(onOptionClick).toHaveBeenCalledExactlyOnceWith(0);
		} finally {
			widget.dispose();
		}
	});
	it.each([120, 60, 40])("records actionable emitted spans and exact gaps at width %i", (width) => {
		const { widget, onOptionClick } = setup();
		try {
			const lines = plain(widget.render(width));
			const spans = buttons(lines);
			expect(spans).toHaveLength(4);
			for (const [index, span] of spans.entries()) {
				expect(span.end).toBeLessThanOrEqual(width);
				expect(widget.handleMouse(mouse("press", span.start + 1, span.row, width))).toEqual({ handled: true });
				expect(onOptionClick).not.toHaveBeenCalled();
				const previous = spans[index - 1];
				if (previous?.row === span.row) {
					expect(span.start - previous.end).toBe(2);
					expect(widget.handleMouse(mouse("press", previous.end, span.row, width))).toBeUndefined();
				}
			}
			const first = spans[0];
			widget.handleMouse(mouse("click", first.start + 1, first.row, width));
			expect(onOptionClick).toHaveBeenCalledExactlyOnceWith(0);
		} finally {
			widget.dispose();
		}
	});
	it("handles own-answer, expand and next without activation on press or repeated clicks", () => {
		const { widget, onOwnAnswerClick, onExpandClick, onNextQuestion, onOptionClick } = setup();
		try {
			const lines = plain(widget.render(120));
			const own = buttons(lines).at(-1)!;
			widget.handleMouse(mouse("press", own.start + 1, own.row));
			expect(onOwnAnswerClick).not.toHaveBeenCalled();
			widget.handleMouse(mouse("click", own.start + 1, own.row));
			expect(onOwnAnswerClick).toHaveBeenCalledOnce();
			widget.handleMouse(mouse("press", 2, 0));
			widget.handleMouse(mouse("click", 2, 0));
			expect(onExpandClick).toHaveBeenCalledOnce();
			const row = lines.findIndex((line) => line.includes("+1 more"));
			const column = visibleWidth(lines[row].split("+1 more")[0]);
			widget.handleMouse(mouse("press", column, row));
			widget.handleMouse(mouse("click", column, row));
			expect(onNextQuestion).toHaveBeenCalledOnce();
			const first = buttons(lines)[0];
			widget.handleMouse(mouse("click", first.start + 1, first.row, 120, 2));
			widget.handleMouse({ ...mouse("press", first.start + 1, first.row), button: "right" });
			expect(onOptionClick).not.toHaveBeenCalled();
		} finally {
			widget.dispose();
		}
	});
	it("has no hit spans below five columns and advertises the native selection bypass", () => {
		const { widget } = setup();
		try {
			expect(buttons(plain(widget.render(4)))).toEqual([]);
			for (let y = 0; y < 4; y++) expect(widget.handleMouse(mouse("press", 1, y, 4))).toBeUndefined();
			vi.stubEnv("TERM_PROGRAM", "ghostty");
			expect(plain(widget.render(120)).join("\n")).toContain("shift+drag");
			vi.stubEnv("TERM_PROGRAM", "iTerm.app");
			expect(plain(widget.render(120)).join("\n")).toContain("option+drag");
		} finally {
			widget.dispose();
			vi.unstubAllEnvs();
		}
	});
	it("receives the actual fullscreen press/release dispatch", () => {
		const { widget, onOptionClick } = setup();
		const terminal = new VirtualTerminal(120, 34);
		const tui = new TuiAltScreen(terminal);
		try {
			tui.addChild(widget);
			tui.start();
			tui.renderNow();
			const first = buttons(plain(widget.render(120)))[0];
			expect(first).toBeDefined();
			terminal.sendInput(`\x1b[<0;${first.start + 2};${first.row + 1}M`);
			expect(onOptionClick).not.toHaveBeenCalled();
			terminal.sendInput(`\x1b[<0;${first.start + 2};${first.row + 1}m`);
			expect(onOptionClick).toHaveBeenCalledExactlyOnceWith(0);
		} finally {
			tui.stop();
			widget.dispose();
		}
	});
});
