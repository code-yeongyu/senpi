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

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

describe("TUI changed-row SGR repaint", () => {
	it("resets SGR state before clearing and repainting changed rows", async () => {
		const terminal = new LoggingVirtualTerminal(72, 6);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["header", "\x1b[38;2;9;131;232mWorking\x1b[0m", "footer", "input"];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["header", "\x1b[38;2;9;131;232mWorking harder\x1b[0m", "footer", "input"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(
			writes.includes("\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[38;2;9;131;232mWorking harder"),
			"changed-row repaint should reset terminal style state immediately after clearing the row",
		);
		assert.ok(
			!writes.includes("\x1b[2K\x1b[38;2;9;131;232m"),
			"repaint should not write truecolor text directly after CSI 2K",
		);

		tui.stop();
	});
});
