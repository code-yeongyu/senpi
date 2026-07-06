import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("TUI render scheduling across stop/start", () => {
	it("renders after restart when a render request was pending at stop()", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["before"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("before")));

		// Request a render and stop before the scheduled render fires.
		component.lines = ["pending-at-stop"];
		tui.requestRender();
		tui.stop();
		await terminal.waitForRender();

		terminal.reset();
		tui.start();
		component.lines = ["after-restart"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(
			terminal.getViewport().some((line) => line.includes("after-restart")),
			`expected "after-restart" in viewport, got: ${JSON.stringify(terminal.getViewport().slice(0, 3))}`,
		);
		tui.stop();
	});

	it("renders after restart when requestRender was called while stopped", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["initial"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		tui.stop();

		// e.g. streaming events arriving while an external editor owns the terminal
		component.lines = ["stopped-update"];
		tui.requestRender();
		await terminal.waitForRender();

		terminal.reset();
		tui.start();
		component.lines = ["resumed"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(
			terminal.getViewport().some((line) => line.includes("resumed")),
			`expected "resumed" in viewport, got: ${JSON.stringify(terminal.getViewport().slice(0, 3))}`,
		);
		tui.stop();
	});

	it("renders after restart when an expedited input render was pending at stop()", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["input-before"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();

		component.lines = ["input-pending"];
		tui.requestRender(false, "input");
		tui.stop();
		await terminal.waitForRender();

		terminal.reset();
		tui.start();
		component.lines = ["input-after-restart"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(
			terminal.getViewport().some((line) => line.includes("input-after-restart")),
			`expected "input-after-restart" in viewport, got: ${JSON.stringify(terminal.getViewport().slice(0, 3))}`,
		);
		tui.stop();
	});
});
