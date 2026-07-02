import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const ROW_CLEAR = "\x1b[2K";
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

class TestComponent implements Component {
	lines: string[] = [];

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class ExpandableTranscriptComponent implements Component {
	private expanded = false;
	readonly tail = Array.from({ length: 6 }, (_, index) => `tail row ${index}`);

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(_width: number): string[] {
		const prefix = ["session title", "tools"];
		if (!this.expanded) {
			return [...prefix, ...this.tail];
		}
		const inserted = Array.from({ length: 16 }, (_, index) => `expanded tool detail ${index}`);
		return [...prefix, ...inserted, ...this.tail];
	}

	invalidate(): void {}
}

class InsertScrollComponent implements Component {
	private inserted = false;
	private readonly prefix = ["p0", "p1", "p2"];
	private readonly tail = ["tail0", "tail1", "tail2", "tail3", "tail4"];

	insertRow(): void {
		this.inserted = true;
	}

	render(_width: number): string[] {
		if (!this.inserted) {
			return [...this.prefix, ...this.tail];
		}
		return [...this.prefix, "tail0", "tail1", "tail2", "tail3", "inserted", "tail4"];
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

function assertEveryRowClearResets(frame: string, scenario: string): void {
	let index = frame.indexOf(ROW_CLEAR);
	assert.notStrictEqual(index, -1, `${scenario} should exercise at least one row clear`);
	while (index !== -1) {
		const afterClear = index + ROW_CLEAR.length;
		const actualSuffix = frame.slice(afterClear, afterClear + SEGMENT_RESET.length);
		assert.strictEqual(
			actualSuffix,
			SEGMENT_RESET,
			`${scenario} emitted a row clear without an immediate SGR reset at byte ${index}`,
		);
		index = frame.indexOf(ROW_CLEAR, afterClear);
	}
}

function armStaleSgr(terminal: LoggingVirtualTerminal): void {
	terminal.write("\x1b[31m");
	terminal.clearWrites();
}

describe("TUI row clears reset stale SGR state", () => {
	it("resets after row clears on full render", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["full render"];
		tui.addChild(component);

		armStaleSgr(terminal);
		try {
			tui.start();
			await terminal.waitForRender();

			assertEveryRowClearResets(terminal.getWrites(), "full render");
		} finally {
			tui.stop();
		}
	});

	it("resets after row clears on scrollback replay", async () => {
		const terminal = new LoggingVirtualTerminal(72, 6);
		const tui = new TUI(terminal);
		const component = new ExpandableTranscriptComponent();
		tui.addChild(component);

		component.setExpanded(true);
		tui.start();
		await terminal.waitForRender();
		armStaleSgr(terminal);

		try {
			component.setExpanded(false);
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes("\x1b[3J"), "scenario should use scrollback replay");
			assertEveryRowClearResets(writes, "scrollback replay");
		} finally {
			tui.stop();
		}
	});

	it("resets after row clears for deleted lines", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["a", "b", "c", "d"];
		tui.start();
		await terminal.waitForRender();
		armStaleSgr(terminal);

		try {
			component.lines = ["a", "b"];
			tui.requestRender();
			await terminal.waitForRender();

			assertEveryRowClearResets(terminal.getWrites(), "deleted lines");
		} finally {
			tui.stop();
		}
	});

	it("resets after row clears for viewport insert-scroll", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new InsertScrollComponent();
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		armStaleSgr(terminal);

		try {
			component.insertRow();
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes("\x1b[1;4r"), "scenario should use insert-scroll");
			assertEveryRowClearResets(writes, "viewport insert-scroll");
		} finally {
			tui.stop();
		}
	});
});
