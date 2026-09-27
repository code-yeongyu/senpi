import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Text } from "../src/components/text.ts";
import { MOUSE_TRACKING } from "../src/mouse-input.ts";
import { Container, type TuiMouseEvent } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const windowsTerminal = process.env.WT_SESSION;
beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	process.env.WT_SESSION = "mouse-test-terminal";
});
afterEach(() => {
	if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
	else Reflect.deleteProperty(process.stdout, "isTTY");
	if (windowsTerminal === undefined) delete process.env.WT_SESSION;
	else process.env.WT_SESSION = windowsTerminal;
});
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}
function setup(clear = true, tall = false) {
	const terminal = new RecordingTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const events: TuiMouseEvent[] = [];
	const root = new Container();
	root.addChild(new Text(Array.from({ length: tall ? 39 : 2 }, () => "padding").join("\n"), 0, 0));
	root.addChild(
		new MouseRegion(new Text("option\nsecond", 0, 0), (event) => {
			events.push(event);
			return event.type === "press" || event.type === "click" ? { handled: true } : undefined;
		}),
	);
	tui.addChild(root);
	tui.start();
	tui.renderNow(clear);
	return { terminal, tui, events, root };
}
function click(terminal: VirtualTerminal, row = 3) {
	terminal.sendInput(`\x1b[<0;5;${row}M`);
	terminal.sendInput(`\x1b[<0;5;${row}m`);
}
it("dispatches a single click with exact local and screen coordinates (#1645)", () => {
	const { terminal, tui, events } = setup();
	try {
		tui.acquireMouseCapture("pending-question");
		click(terminal);
		const clicks = events.filter((e) => e.type === "click");
		assert.equal(clicks.length, 1);
		const { type, x, y, screenX, screenY } = clicks[0];
		assert.deepEqual({ type, x, y, screenX, screenY }, { type: "click", x: 4, y: 0, screenX: 4, screenY: 2 });
	} finally {
		tui.stop();
	}
});
it("writes one enable on acquire and unconditional disable on stop", () => {
	const { terminal, tui } = setup();
	tui.acquireMouseCapture("pending-question");
	assert.equal(terminal.writes.filter((s) => s === MOUSE_TRACKING.inline).length, 1);
	tui.stop();
	assert.equal(terminal.writes.filter((s) => s === MOUSE_TRACKING.disable).length, 1);
});
it("consumes SGR before later extension listeners even without capture", () => {
	const { terminal, tui } = setup();
	try {
		const seen: string[] = [];
		tui.addInputListener((data) => {
			seen.push(data);
			return undefined;
		});
		click(terminal);
		assert.deepEqual(seen, []);
		terminal.sendInput("a");
		assert.deepEqual(seen, ["a"]);
	} finally {
		tui.stop();
	}
});
it("does not click on a moved release", () => {
	const { terminal, tui, events } = setup();
	try {
		tui.acquireMouseCapture("pending-question");
		terminal.sendInput("\x1b[<0;5;3M");
		terminal.sendInput("\x1b[<0;6;3m");
		assert.deepEqual(
			events.map((e) => e.type),
			["press"],
		);
	} finally {
		tui.stop();
	}
});
it("unknown anchors and capture-off never dispatch or insert editor text", () => {
	for (const clear of [false, true]) {
		const { terminal, tui, events } = setup(clear);
		try {
			const editor = new Editor(tui, defaultEditorTheme);
			tui.setFocus(editor);
			if (!clear) tui.acquireMouseCapture("pending-question");
			click(terminal);
			assert.deepEqual(events, []);
			assert.equal(editor.getText(), "");
		} finally {
			tui.stop();
		}
	}
});
it("consumes wheel, motion, other buttons and modifiers without dispatch", () => {
	const { terminal, tui, events } = setup();
	try {
		tui.acquireMouseCapture("pending-question");
		for (const button of [64, 65, 32, 35, 1, 2, 4, 8, 16]) terminal.sendInput(`\x1b[<${button};5;3M`);
		assert.deepEqual(events, []);
	} finally {
		tui.stop();
	}
});
it("maps a tall frame and ignores resize until a committed render", () => {
	const { terminal, tui, events } = setup(false, true);
	try {
		tui.acquireMouseCapture("pending-question");
		click(terminal, 24);
		assert.equal(events.filter((e) => e.type === "click").length, 1);
		assert.equal(events.find((e) => e.type === "click")?.y, 1);
		events.length = 0;
		terminal.resize(80, 20);
		click(terminal, 20);
		assert.equal(events.length, 0);
		tui.renderNow();
		click(terminal, 20);
		assert.equal(events.filter((e) => e.type === "click").length, 1);
	} finally {
		tui.stop();
	}
});
it("rejects a press after the committed target layout changes", () => {
	const { terminal, tui, events, root } = setup();
	try {
		tui.acquireMouseCapture("pending-question");
		terminal.sendInput("\x1b[<0;5;3M");
		root.removeChild(root.children[1]);
		root.addChild(new Text("replacement", 0, 0));
		tui.renderNow();
		terminal.sendInput("\x1b[<0;5;3m");
		assert.equal(events.filter((e) => e.type === "click").length, 0);
	} finally {
		tui.stop();
	}
});
it("keeps a same-target gesture across a no-op committed render", () => {
	const { terminal, tui, events } = setup();
	try {
		tui.acquireMouseCapture("pending-question");
		terminal.sendInput("\x1b[<0;5;3M");
		tui.renderNow();
		terminal.sendInput("\x1b[<0;5;3m");
		assert.equal(events.filter((e) => e.type === "click").length, 1);
	} finally {
		tui.stop();
	}
});
it("does not scan committed mouse frames while capture is inactive", () => {
	class ObservedTui extends TuiMainScreen {
		frameReads = 0;
		protected override noteCommittedMouseFrame() {
			this.frameReads++;
			super.noteCommittedMouseFrame();
		}
	}
	const terminal = new RecordingTerminal(80, 24);
	const tui = new ObservedTui(terminal);
	tui.addChild(new Text("history", 0, 0));
	try {
		tui.renderNow();
		const firstRenderReads = tui.frameReads;
		tui.renderNow();
		assert.equal(tui.frameReads, firstRenderReads);
		const release = tui.acquireMouseCapture("pending-question");
		assert.ok(tui.frameReads > firstRenderReads, "late capture must refresh the current committed anchor");
		release();
		const readsAfterRelease = tui.frameReads;
		tui.renderNow();
		assert.equal(tui.frameReads, readsAfterRelease);
	} finally {
		tui.stop();
	}
});
it("refreshes the current frame when capture resumes after history changed", () => {
	const { terminal, tui, events, root } = setup(false, true);
	try {
		const release = tui.acquireMouseCapture("pending-question");
		release();
		root.children[0] = new Text(Array.from({ length: 45 }, () => "new padding").join("\n"), 0, 0);
		tui.renderNow();
		tui.acquireMouseCapture("pending-question");
		terminal.sendInput("\x1b[<0;5;24M");
		tui.renderNow();
		terminal.sendInput("\x1b[<0;5;24m");
		assert.equal(events.filter((event) => event.type === "click").length, 1);
		assert.equal(events.find((event) => event.type === "click")?.y, 1);
	} finally {
		tui.stop();
	}
});
it("does not reuse raw-line normalization from a different restored frame", () => {
	const terminal = new RecordingTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const text = new Text("earlier frame", 0, 0);
	tui.addChild(text);
	try {
		tui.renderNow();
		const earlier = tui.captureRenderState();
		text.setText("current frame");
		tui.renderNow();
		const current = tui.captureRenderState();
		tui.restoreRenderState(earlier);
		tui.renderNow();
		assert.deepEqual(tui.captureRenderState().previousLines, current.previousLines);
	} finally {
		tui.stop();
	}
});
it("rejects a stale click when capture enables before a pending target replacement commits", () => {
	const terminal = new RecordingTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const root = new Container();
	const events: string[] = [];
	const region = (name: string) =>
		new MouseRegion(new Text("option", 0, 0), (event) => {
			events.push(`${name}:${event.type}`);
			return { handled: true };
		});
	root.addChild(region("old"));
	tui.addChild(root);
	try {
		tui.start();
		tui.renderNow(true);
		root.removeChild(root.children[0]);
		root.addChild(region("new"));
		tui.acquireMouseCapture("pending-question");
		terminal.sendInput("\x1b[<0;5;1M");
		tui.renderNow();
		terminal.sendInput("\x1b[<0;5;1m");
		assert.deepEqual(events, ["old:press"]);
	} finally {
		tui.stop();
	}
});
it("can acquire capture during component rendering without leaking a reentrant lease", () => {
	const terminal = new RecordingTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	let release: (() => void) | undefined;
	tui.addChild({
		render() {
			release ??= tui.acquireMouseCapture("pending-question");
			return ["option"];
		},
		invalidate() {},
	});
	try {
		tui.renderNow();
		assert.ok(release);
		release();
		assert.equal(terminal.writes.at(-1), MOUSE_TRACKING.disable);
	} finally {
		tui.stop();
	}
});
it("enables Windows Terminal but rejects legacy Windows and Termux", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	const termux = process.env.TERMUX_VERSION;
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		for (const [wt, tx, enabled] of [
			[undefined, undefined, false],
			["fixture", undefined, true],
			["fixture", "fixture", false],
		] as const) {
			if (wt === undefined) delete process.env.WT_SESSION;
			else process.env.WT_SESSION = wt;
			if (tx === undefined) delete process.env.TERMUX_VERSION;
			else process.env.TERMUX_VERSION = tx;
			const { terminal, tui } = setup();
			try {
				tui.acquireMouseCapture("pending-question");
				assert.equal(terminal.writes.includes(MOUSE_TRACKING.inline), enabled);
			} finally {
				tui.stop();
			}
		}
	} finally {
		if (platform) Object.defineProperty(process, "platform", platform);
		if (termux === undefined) delete process.env.TERMUX_VERSION;
		else process.env.TERMUX_VERSION = termux;
	}
});
it("does not enable tracking on a non-TTY", () => {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
	const { terminal, tui, events } = setup();
	try {
		tui.acquireMouseCapture("pending-question");
		click(terminal);
		assert.deepEqual(events, []);
		assert.equal(terminal.writes.includes(MOUSE_TRACKING.inline), false);
	} finally {
		tui.stop();
	}
});
