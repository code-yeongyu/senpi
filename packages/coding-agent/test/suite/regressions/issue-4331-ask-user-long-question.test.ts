import { type Component, Container, setKeybindings, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { QuestionRequest } from "../../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { createChatViewport } from "../../../src/modes/interactive/chat-viewport.ts";
import { AskUserAsyncWidget } from "../../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../../src/modes/interactive/components/ask-user-question.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

// senpi#4331: a question taller than a narrow terminal must stay readable to its last line, wrapped to the
// terminal width with no glyph cut. The regular screen keeps the rows above the viewport in scrollback; the
// fullscreen dock must let the wheel scroll to them instead of clipping.
const COLUMNS = 28;
const ROWS = 8;
const LATIN = `FIRSTWORD ${"which engine should this service standardize on ".repeat(6)}LASTWORD`;
const CJK = `첫줄시작 ${"이 서비스는 어떤 데이터베이스 엔진을 표준으로 ".repeat(4)}마지막줄`;
const WHEEL_UP = `\x1b[<64;2;${ROWS}M`;
const WHEEL_DOWN = `\x1b[<65;2;${ROWS}M`;

type Surface = "widget" | "overlay";

function request(question: string): QuestionRequest {
	return {
		requestId: "req-4331",
		waitForAnswer: false,
		timeoutMs: 0,
		questions: [
			{
				id: "db",
				header: "Database",
				question,
				options: [{ label: "Postgres" }, { label: "SQLite" }],
				multiSelect: false,
			},
		],
	};
}

function mount(surface: Surface, question: string): Component & { dispose(): void } {
	return surface === "widget"
		? new AskUserAsyncWidget({ request: request(question), draft: {}, timeoutMs: 0, onExpire: () => {} })
		: new AskUserQuestionComponent(request(question), () => {});
}

async function regularScreenLines(component: Component): Promise<string[]> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TuiMainScreen(terminal);
	tui.addChild(component);
	try {
		tui.start();
		tui.renderNow();
		await terminal.flush();
		return terminal.getScrollBuffer();
	} finally {
		tui.stop();
	}
}

/** Every row the wheel can bring into the fullscreen dock, top to bottom. */
async function fullscreenReachableLines(surface: Surface, component: Component): Promise<string[]> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TuiAltScreen(terminal);
	const slot = new Container();
	slot.addChild(component);
	const viewport = createChatViewport({
		document: new Container(),
		pendingMessages: new Container(),
		status: new Container(),
		widgetsAbove: surface === "widget" ? slot : new Container(),
		editor: surface === "overlay" ? slot : new Container(),
		footer: new Container(),
	});
	tui.setLayoutRoot(viewport.root);
	const frame = async (input?: string): Promise<string[]> => {
		if (input !== undefined) terminal.sendInput(input);
		tui.renderNow();
		await terminal.flush();
		return terminal.getViewport();
	};
	try {
		tui.start();
		let screen = await frame();
		for (let step = 0; step < 100; step++) {
			const next = await frame(WHEEL_UP);
			if (next.join("\n") === screen.join("\n")) break;
			screen = next;
		}
		const lines = [...screen];
		for (let step = 0; step < 100; step++) {
			const next = await frame(WHEEL_DOWN);
			if (next.join("\n") === screen.join("\n")) break;
			screen = next;
			lines.push(screen.at(-1) ?? "");
		}
		return lines;
	} finally {
		tui.stop();
	}
}

function expectWholeQuestion(lines: string[], question: string): void {
	const squeeze = (text: string) => text.replace(/\s+/g, "");
	expect(squeeze(lines.join(""))).toContain(squeeze(question));
	expect(lines.length).toBeGreaterThan(ROWS);
	expect(lines.join("\n")).not.toMatch(/…\s*$/m);
}

const CASES = (["widget", "overlay"] as const).flatMap((surface) =>
	[
		["Latin", LATIN],
		["CJK", CJK],
	].map(([script, question]) => [surface, script, question] as const),
);

describe("long ask-user question stays readable on a narrow terminal (#4331)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it.each(CASES)("regular screen: the %s shows the whole %s question", async (surface, _script, question) => {
		const component = mount(surface, question);
		try {
			expectWholeQuestion(await regularScreenLines(component), question);
		} finally {
			component.dispose();
		}
	});

	it.each(CASES)("fullscreen: the wheel reaches the whole %s %s question", async (surface, _script, question) => {
		const component = mount(surface, question);
		try {
			expectWholeQuestion(await fullscreenReachableLines(surface, component), question);
		} finally {
			component.dispose();
		}
	});
});
