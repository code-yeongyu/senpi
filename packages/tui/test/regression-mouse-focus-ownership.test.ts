import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Text } from "../src/components/text.ts";
import { Container } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// A clickable row wrapper with no handleInput: the shape coding-agent's
// questionMouseRegion() builds for ask-user option and Submit rows.
function clickableRow(label: string, onClick?: () => void): MouseRegion {
	return new MouseRegion(new Text(label, 0, 0), (event) => {
		if (event.y !== 0) return undefined;
		if (event.type === "click") onClick?.();
		return { handled: true, focus: true };
	});
}

/** Stands in for any real keyboard owner (composer editor, question component). */
class KeyReceiver extends Container {
	readonly received: string[] = [];
	handleInput(data: string): void {
		this.received.push(data);
	}
}

const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const windowsTerminal = process.env.WT_SESSION;
beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	process.env.WT_SESSION = "mouse-focus-ownership-test";
});
afterEach(() => {
	if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
	else Reflect.deleteProperty(process.stdout, "isTTY");
	if (windowsTerminal === undefined) delete process.env.WT_SESSION;
	else process.env.WT_SESSION = windowsTerminal;
});

function mount(row: MouseRegion, wrap?: KeyReceiver) {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TuiMainScreen(terminal);
	const root = new Container();
	root.addChild(new Text("padding\npadding", 0, 0));
	if (wrap) {
		wrap.addChild(row);
		root.addChild(wrap);
	} else root.addChild(row);
	tui.addChild(root);
	tui.start();
	tui.renderNow(true);
	tui.acquireMouseCapture("pending-question");
	return { terminal, tui };
}

function click(terminal: VirtualTerminal, row = 3): void {
	terminal.sendInput(`\x1b[<0;5;${row}M`);
	terminal.sendInput(`\x1b[<0;5;${row}m`);
}

it("a click leaves keyboard focus where it was when the clicked row cannot receive keys", () => {
	const { terminal, tui } = mount(clickableRow("Submit"));
	try {
		const composer = new KeyReceiver();
		tui.setFocus(composer);

		click(terminal);

		assert.equal(tui.getFocusedComponent(), composer);
		terminal.sendInput("a");
		assert.deepEqual(composer.received, ["a"]);
	} finally {
		tui.stop();
	}
});

it("a click on a row inside a key-receiving container keeps that container focused", () => {
	const question = new KeyReceiver();
	const { terminal, tui } = mount(clickableRow("1. OAuth"), question);
	try {
		click(terminal);

		assert.equal(tui.getFocusedComponent(), question);
		terminal.sendInput("a");
		assert.deepEqual(question.received, ["a"]);
	} finally {
		tui.stop();
	}
});

it("a focus change made by the click handler survives the mouse focus application", () => {
	const question = new KeyReceiver();
	const composer = new KeyReceiver();
	// Submitting restores composer focus, exactly like hideQuestionOverlay() does.
	const { terminal, tui } = mount(
		clickableRow("Submit (2/2 answered)", () => tui.setFocus(composer)),
		question,
	);
	try {
		tui.setFocus(question);

		click(terminal);

		assert.equal(tui.getFocusedComponent(), composer);
		terminal.sendInput("a");
		assert.deepEqual(composer.received, ["a"]);
		assert.deepEqual(question.received, []);
	} finally {
		tui.stop();
	}
});
