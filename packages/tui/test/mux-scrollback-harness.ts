import assert from "node:assert";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

export const FRAME_BEGIN = "\x1b[?2026h";
export const FRAME_END = "\x1b[?2026l";
export const ROW_CLEAR = "\x1b[2K";
export const SCREEN_CLEAR = "\x1b[2J";
export const SCROLLBACK_CLEAR = "\x1b[3J";
export const HOME = "\x1b[H";
export const KITTY_IMAGE_LINE = "\x1b_Gi=42,r=1;AAAA\x1b\\";

export class LoggingVirtualTerminal extends VirtualTerminal {
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

export class StaticComponent implements Component {
	lines: string[] = [];

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

export class ExpandableTranscriptComponent implements Component {
	private expanded = false;
	private readonly tail = Array.from({ length: 6 }, (_, index) => `tail row ${index}`);

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

export class OverlayComponent implements Component {
	render(_width: number): string[] {
		return ["OVERLAY"];
	}

	invalidate(): void {}
}

export type TuiConstructorOptions = ConstructorParameters<typeof TUI>[1];

export function muxOptions(): TuiConstructorOptions {
	return { muxDetector: () => true };
}

export function nonMuxOptions(): TuiConstructorOptions {
	return { muxDetector: () => false };
}

export function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

export function assertFrameBalanced(writes: string): void {
	assert.strictEqual(countOccurrences(writes, FRAME_BEGIN), countOccurrences(writes, FRAME_END));
}

export async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

export async function renderReplayTrigger(options: TuiConstructorOptions): Promise<{
	readonly terminal: LoggingVirtualTerminal;
	readonly tui: TUI;
	readonly writes: string;
}> {
	const terminal = new LoggingVirtualTerminal(72, 6);
	const tui = new TUI(terminal, options);
	const component = new ExpandableTranscriptComponent();
	tui.addChild(component);

	component.setExpanded(true);
	tui.start();
	await terminal.waitForRender();
	terminal.clearWrites();

	component.setExpanded(false);
	tui.requestRender();
	await terminal.waitForRender();
	const writes = terminal.getWrites();
	return { terminal, tui, writes };
}
