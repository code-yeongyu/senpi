import assert from "node:assert/strict";
import { it } from "node:test";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Text } from "../src/components/text.ts";
import { type CursorPosition, ProcessTerminal } from "../src/terminal.ts";
import { TuiBase } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CaptureTui extends TuiBase {
	readonly mode = "regular" as const;
	readonly tracking: boolean[] = [];
	override applyMouseTracking(enabled: boolean): void {
		this.tracking.push(enabled);
	}
	block(on: boolean): void {
		this.setMouseBlocker("suspended", on);
	}
	line(row: number): number | undefined {
		return this.resolveFrameLine(row);
	}
}

it("leases transition only at zero and release idempotently (#1645)", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	const a = tui.acquireMouseCapture("pending-question");
	const b = tui.acquireMouseCapture("always");
	assert.deepEqual(tui.tracking, [true]);
	a();
	a();
	assert.deepEqual(tui.tracking, [true]);
	b();
	b();
	assert.deepEqual(tui.tracking, [true, false]);
	tui.stop();
});
it("blockers preserve lease intent and stop resets bookkeeping", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	const old = tui.acquireMouseCapture("pending-question");
	tui.block(true);
	tui.block(false);
	assert.deepEqual(tui.tracking, [true, false, true]);
	tui.stop();
	old();
	const next = tui.acquireMouseCapture("always");
	next();
	assert.deepEqual(tui.tracking, [true, false, true, true, false]);
	tui.stop();
});
it("unknown first-frame anchor cannot misfire", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	tui.addChild(new Text("a\nb\nc\nd\ne", 0, 0));
	tui.renderNow();
	assert.equal(tui.line(3), undefined);
	tui.stop();
});
it("cleared short frame maps only visible committed lines", () => {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new CaptureTui(terminal);
	tui.addChild(new Text("a\nb\nc\nd\ne", 0, 0));
	tui.renderNow(true);
	assert.equal(tui.line(3), 2);
	assert.equal(tui.line(9), undefined);
	assert.equal(tui.line(0), undefined);
	terminal.resize(100, 24);
	assert.equal(tui.line(3), undefined);
	tui.renderNow();
	assert.equal(tui.line(3), 2);
	tui.stop();
});
it("viewport frame maps the bottom row to the last frame line", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	tui.addChild(new Text(Array.from({ length: 40 }, (_, i) => String(i)).join("\n"), 0, 0));
	tui.renderNow();
	assert.equal(tui.line(24), 39);
	assert.equal(tui.line(1), 16);
	assert.equal(tui.line(25), undefined);
	tui.stop();
});
it("images invalidate even a cleared frame", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	tui.addChild({ render: () => ["\x1b_Ga=T,f=100;AAAA\x1b\\"], invalidate: () => {} });
	tui.renderNow(true);
	assert.equal(tui.line(1), undefined);
	tui.stop();
});

it("anchors a fresh short frame and invalidates real stdout/stderr writes", async (t) => {
	class ScriptedTerminal extends ProcessTerminal {
		lastQuery?: Promise<CursorPosition | undefined>;
		override queryCursorPosition(): Promise<CursorPosition | undefined> {
			this.lastQuery = super.queryCursorPosition();
			return this.lastQuery;
		}
		override get columns(): number {
			return 80;
		}
		override get rows(): number {
			return 24;
		}
	}
	class InlineTui extends TuiMainScreen {
		line(row: number): number | undefined {
			return this.resolveFrameLine(row);
		}
	}
	const old = process.env.PI_TUI_KEYBOARD_PROTOCOL;
	const windowsTerminal = process.env.WT_SESSION;
	process.env.PI_TUI_KEYBOARD_PROTOCOL = "0";
	process.env.WT_SESSION = "mouse-test-terminal";
	const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	const output: string[] = [];
	const errors: string[] = [];
	t.mock.method(process.stdin, "resume", () => process.stdin);
	t.mock.method(process.stdin, "pause", () => process.stdin);
	t.mock.method(process, "kill", () => true);
	t.mock.method(process.stdout, "write", ((chunk: string | Uint8Array) => {
		const text = String(chunk);
		output.push(text);
		if (text === "\x1b[?6n") process.stdin.emit("data", "\x1b[?19;1R");
		return true;
	}) as typeof process.stdout.write);
	t.mock.method(process.stderr, "write", ((chunk: string | Uint8Array) => {
		errors.push(String(chunk));
		return true;
	}) as typeof process.stderr.write);
	const terminal = new ScriptedTerminal();
	const tui = new InlineTui(terminal);
	t.after(() => {
		tui.stop();
		if (old === undefined) delete process.env.PI_TUI_KEYBOARD_PROTOCOL;
		else process.env.PI_TUI_KEYBOARD_PROTOCOL = old;
		if (windowsTerminal === undefined) delete process.env.WT_SESSION;
		else process.env.WT_SESSION = windowsTerminal;
		if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	});
	let clicks = 0;
	tui.addChild(new Text("a\nb\nc\nd", 0, 0));
	tui.addChild(
		new MouseRegion(new Text("option", 0, 0), (event) => {
			if (event.type === "click") clicks++;
			return event.type === "press" || event.type === "click" ? { handled: true } : undefined;
		}),
	);
	tui.start();
	tui.acquireMouseCapture("pending-question");
	tui.renderNow();
	assert.ok(terminal.lastQuery);
	await terminal.lastQuery;
	assert.equal(tui.line(19), 4);
	assert.equal(tui.line(15), 0);
	process.stdin.emit("data", "\x1b[<0;5;19M\x1b[<0;5;19m");
	assert.equal(clicks, 1);
	process.stderr.write("external diagnostic");
	assert.deepEqual(errors, ["external diagnostic"]);
	assert.equal(tui.line(19), undefined);
	tui.renderNow();
	await terminal.lastQuery;
	assert.equal(tui.line(19), 4);
	process.stdout.write("external output");
	assert.equal(output.includes("external output"), true);
	assert.equal(tui.line(19), undefined);
	tui.renderNow();
	await terminal.lastQuery;
	assert.equal(tui.line(15), 0);
	assert.equal(output.filter((s) => s === "\x1b[?6n").length, 3);
});
