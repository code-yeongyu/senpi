import assert from "node:assert";
import { describe, it } from "node:test";
import { TUI } from "../src/tui.ts";
import {
	assertFrameBalanced,
	countOccurrences,
	LoggingVirtualTerminal,
	nonMuxOptions,
	ROW_CLEAR,
	SCREEN_CLEAR,
	SCROLLBACK_CLEAR,
	StaticComponent,
} from "./mux-scrollback-harness.ts";

// senpi#3405: outside a multiplexer, a Windows resize took the full-redraw path, which (with ESC[3J
// suppressed there since #1147) appended one more copy of the whole transcript to the scrollback.

async function onWin32<T>(run: () => Promise<T>): Promise<T> {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platformDescriptor);
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	try {
		return await run();
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
	}
}

async function startedTranscript(columns: number, rows: number, lineCount: number) {
	const terminal = new LoggingVirtualTerminal(columns, rows);
	const tui = new TUI(terminal, nonMuxOptions());
	const component = new StaticComponent();
	component.lines = Array.from({ length: lineCount }, (_, index) => `transcript line ${index}`);
	tui.addChild(component);
	tui.start();
	await terminal.waitForRender();
	terminal.clearWrites();
	return { terminal, tui };
}

function assertViewportOnlyRepaint(writes: string, rows: number): void {
	assert.strictEqual(countOccurrences(writes, SCREEN_CLEAR), 0, "a Windows resize must not clear the screen");
	assert.strictEqual(countOccurrences(writes, SCROLLBACK_CLEAR), 0, "a Windows resize must not clear scrollback");
	assert.ok(countOccurrences(writes, ROW_CLEAR) <= rows, "a Windows resize repaints at most the visible rows");
	assert.strictEqual(countOccurrences(writes, "transcript line 0"), 0, "off-screen rows must not be re-emitted");
	assertFrameBalanced(writes);
}

describe("senpi#3405 Windows resize outside a multiplexer", () => {
	it("repaints only the viewport on a width change", async () => {
		await onWin32(async () => {
			const { terminal, tui } = await startedTranscript(40, 6, 30);
			terminal.resize(50, 6);
			await terminal.waitForRender();
			assertViewportOnlyRepaint(terminal.getWrites(), terminal.rows);
			tui.stop();
		});
	});

	it("repaints only the viewport on a height-only change", async () => {
		await onWin32(async () => {
			const { terminal, tui } = await startedTranscript(40, 10, 30);
			terminal.resize(40, 7);
			await terminal.waitForRender();
			assertViewportOnlyRepaint(terminal.getWrites(), terminal.rows);
			tui.stop();
		});
	});

	it("re-emits no off-screen transcript across a width round trip", async () => {
		await onWin32(async () => {
			const { terminal, tui } = await startedTranscript(40, 6, 30);
			terminal.resize(50, 6);
			await terminal.waitForRender();
			terminal.resize(40, 6);
			await terminal.waitForRender();
			const writes = terminal.getWrites();
			assert.strictEqual(countOccurrences(writes, "transcript line 0"), 0);
			assert.strictEqual(countOccurrences(writes, SCREEN_CLEAR), 0);
			tui.stop();
		});
	});
});
