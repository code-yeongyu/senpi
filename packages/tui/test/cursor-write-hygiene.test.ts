import assert from "node:assert";
import { describe, it } from "node:test";
import { setCapabilities } from "../src/terminal-image.ts";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const FRAME_BEGIN = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

interface OutputChunk {
	readonly kind: "write" | "hideCursor" | "showCursor";
	readonly data: string;
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private readonly chunks: OutputChunk[] = [];

	override write(data: string): void {
		this.chunks.push({ kind: "write", data });
		super.write(data);
	}

	override hideCursor(): void {
		this.chunks.push({ kind: "hideCursor", data: HIDE_CURSOR });
		super.hideCursor();
	}

	override showCursor(): void {
		this.chunks.push({ kind: "showCursor", data: SHOW_CURSOR });
		super.showCursor();
	}

	getChunks(): readonly OutputChunk[] {
		return this.chunks;
	}
}

class CursorComponent implements Component, Focusable {
	focused = false;
	private frame = 0;

	nextFrame(): void {
		this.frame += 1;
	}

	render(_width: number): string[] {
		const marker = this.focused ? CURSOR_MARKER : "";
		return [`frame ${this.frame} ${marker}`];
	}

	invalidate(): void {}
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

async function renderNextFrame(tui: TUI, terminal: VirtualTerminal, component: CursorComponent): Promise<void> {
	component.nextFrame();
	tui.requestRender();
	await terminal.waitForRender();
}

function outputText(chunks: readonly OutputChunk[]): string {
	return chunks.map((chunk) => chunk.data).join("");
}

function postFrameChunks(chunks: readonly OutputChunk[]): OutputChunk[][] {
	const result: OutputChunk[][] = [];
	let active: OutputChunk[] | undefined;

	for (const chunk of chunks) {
		if (chunk.data.includes(FRAME_BEGIN)) {
			active = undefined;
		}
		if (active) {
			result[result.length - 1]?.push(chunk);
		}
		if (chunk.data.includes(FRAME_END)) {
			active = [];
			result.push(active);
		}
	}

	return result;
}

async function startHiddenCursorTui(): Promise<{
	readonly terminal: LoggingVirtualTerminal;
	readonly tui: TUI;
	readonly component: CursorComponent;
}> {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const terminal = new LoggingVirtualTerminal(40, 6);
	const tui = new TUI(terminal, false);
	const component = new CursorComponent();
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, component };
}

describe("cursor write hygiene", () => {
	it("omits repeated hidden cursor bytes after the first hidden frame", async () => {
		const { terminal, tui, component } = await startHiddenCursorTui();

		// given
		await renderNextFrame(tui, terminal, component);
		const hideBytesAfterFrameOne = countOccurrences(outputText(terminal.getChunks()), HIDE_CURSOR);

		// when
		await renderNextFrame(tui, terminal, component);
		await renderNextFrame(tui, terminal, component);

		// then
		const hideBytesAfterSteadyFrames = countOccurrences(outputText(terminal.getChunks()), HIDE_CURSOR);
		assert.strictEqual(hideBytesAfterSteadyFrames, hideBytesAfterFrameOne);

		tui.stop();
	});

	it("emits exactly one post-frame write after each synchronized frame", async () => {
		const { terminal, tui, component } = await startHiddenCursorTui();

		// given
		await renderNextFrame(tui, terminal, component);

		// when
		await renderNextFrame(tui, terminal, component);

		// then
		for (const chunks of postFrameChunks(terminal.getChunks())) {
			assert.strictEqual(chunks.length, 1);
			assert.strictEqual(chunks[0]?.kind, "write");
		}

		tui.stop();
	});

	it("emits show cursor bytes exactly once when hardware cursor visibility is enabled", async () => {
		const { terminal, tui, component } = await startHiddenCursorTui();

		// given
		await renderNextFrame(tui, terminal, component);

		// when
		tui.setShowHardwareCursor(true);
		await terminal.waitForRender();
		await renderNextFrame(tui, terminal, component);

		// then
		assert.strictEqual(countOccurrences(outputText(terminal.getChunks()), SHOW_CURSOR), 1);

		tui.stop();
	});

	it("reasserts hidden cursor visibility on the first frame after restart", async () => {
		const { terminal, tui, component } = await startHiddenCursorTui();

		// given
		await renderNextFrame(tui, terminal, component);
		tui.stop();
		const hideBytesBeforeRestart = countOccurrences(outputText(terminal.getChunks()), HIDE_CURSOR);

		// when
		tui.start();
		await terminal.waitForRender();

		// then
		const hideBytesAfterRestart = countOccurrences(outputText(terminal.getChunks()), HIDE_CURSOR);
		assert.strictEqual(hideBytesAfterRestart, hideBytesBeforeRestart + 1);

		tui.stop();
	});
});
