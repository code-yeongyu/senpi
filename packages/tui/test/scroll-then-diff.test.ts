import assert from "node:assert";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const FRAME_BEGIN = "\x1b[?2026h\x1b[?7l";
const FRAME_END = "\x1b[?7h\x1b[?2026l";
const REGION_1_TO_5 = "\x1b[1;5r";
const SCROLL_REGION_PATTERN = /\x1b\[1;\d+r/;
const ROW_CLEAR = "\x1b[2K";
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
const STABLE_BOTTOM_ROWS = ["BOTTOM_SENTINEL_A", "BOTTOM_SENTINEL_B", "BOTTOM_SENTINEL_C"] as const;
const PRE_CHANGE_TAIL_MUTATE_FALLBACK_BYTES = 430;
const PURE_APPEND_GOLDEN =
	`${FRAME_BEGIN}\x1b[1;5r\x1b[5;1H\n\x1b[r` +
	`\x1b[5;1H${ROW_CLEAR}${SEGMENT_RESET}append 1${SEGMENT_RESET}${FRAME_END}`;

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

class LinesComponent implements Component {
	lines: string[] = [];

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {}
}

async function driveRender(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	const render = Reflect.get(tui, "doRender");
	assert.strictEqual(typeof render, "function");
	Reflect.apply(render, tui, []);
	await terminal.flush();
}

function initialLines(): string[] {
	return [
		"history 0",
		"history 1",
		"history 2",
		"history 3",
		"scroll away",
		"body 0",
		"body 1",
		"mutable 0",
		"body 3",
		...STABLE_BOTTOM_ROWS,
	];
}

async function renderTick(nextLines: string[]): Promise<{
	readonly terminal: LoggingVirtualTerminal;
	readonly tui: TUI;
	readonly writes: string;
}> {
	const terminal = new LoggingVirtualTerminal(72, 8);
	const tui = new TUI(terminal);
	const component = new LinesComponent();
	component.lines = initialLines();
	tui.addChild(component);
	await driveRender(tui, terminal);
	terminal.clearWrites();

	component.lines = nextLines;
	await driveRender(tui, terminal);
	return { terminal, tui, writes: terminal.getWrites() };
}

function pureAppendLines(): string[] {
	return [
		"history 0",
		"history 1",
		"history 2",
		"history 3",
		"scroll away",
		"body 0",
		"body 1",
		"mutable 0",
		"body 3",
		"append 1",
		...STABLE_BOTTOM_ROWS,
	];
}

function tailMutateLines(): string[] {
	const lines = pureAppendLines();
	lines[7] = "mutable 1";
	return lines;
}

function excessMutationLines(): string[] {
	return [
		"history 0",
		"history 1",
		"history 2",
		"history 3",
		"scroll away",
		"body 0 changed",
		"body 1 changed",
		"mutable 1",
		"body 3 changed",
		"append 1 changed",
		"BOTTOM_SENTINEL_A changed",
		STABLE_BOTTOM_ROWS[1],
		STABLE_BOTTOM_ROWS[2],
	];
}

async function fullRenderViewport(lines: readonly string[]): Promise<string[]> {
	const terminal = new VirtualTerminal(72, 8);
	const tui = new TUI(terminal);
	const component = new LinesComponent();
	component.lines = [...lines];
	tui.addChild(component);
	await driveRender(tui, terminal);
	const viewport = terminal.getViewport();
	tui.stop();
	return viewport;
}

describe("scroll-then-diff viewport rendering", () => {
	it("keeps pure append ticks byte-identical to the insert-scroll golden", async () => {
		const { tui, writes } = await renderTick(pureAppendLines());

		assert.strictEqual(writes, PURE_APPEND_GOLDEN);
		tui.stop();
	});

	it("uses one scroll-region frame for append ticks with bounded shifted-row mutations", async () => {
		const { terminal, tui, writes } = await renderTick(tailMutateLines());

		assert.ok(writes.includes(REGION_1_TO_5), "bounded tail mutation should use the scroll-region fast path");
		assert.strictEqual(
			(writes.match(/\x1b\[\?2026h/g) ?? []).length,
			1,
			"bounded tail mutation should stay inside one synchronized frame",
		);
		for (const sentinel of STABLE_BOTTOM_ROWS) {
			assert.ok(!writes.includes(sentinel), `stable bottom sentinel should not be repainted: ${sentinel}`);
		}
		assert.ok(
			Buffer.byteLength(writes) < PRE_CHANGE_TAIL_MUTATE_FALLBACK_BYTES,
			`bounded tail mutation should stay below fallback fixture ${PRE_CHANGE_TAIL_MUTATE_FALLBACK_BYTES}, got ${Buffer.byteLength(writes)}`,
		);
		assert.deepStrictEqual(await fullRenderViewport(tailMutateLines()), terminal.getViewport());
		tui.stop();
	});

	it("falls back when shifted-row mutations exceed the bounded diff budget", async () => {
		const { terminal, tui, writes } = await renderTick(excessMutationLines());

		assert.ok(!SCROLL_REGION_PATTERN.test(writes), "excess mutations should not use the scroll-region fast path");
		assert.deepStrictEqual(terminal.getViewport(), await fullRenderViewport(excessMutationLines()));
		tui.stop();
	});

	it("matches full-render screen state after 50 mixed append and bounded-mutation ticks", async () => {
		const terminal = new LoggingVirtualTerminal(72, 8);
		const tui = new TUI(terminal);
		const component = new LinesComponent();
		let lines = initialLines();
		component.lines = lines;
		tui.addChild(component);
		await driveRender(tui, terminal);

		for (let tick = 1; tick <= 50; tick++) {
			const next = [...lines];
			const insertionIndex = next.length - STABLE_BOTTOM_ROWS.length;
			if (tick % 3 !== 0) {
				next[insertionIndex - 2] = `mutable ${tick}`;
			}
			next.splice(insertionIndex, 0, `append ${tick}`);
			lines = next;
			component.lines = lines;
			await driveRender(tui, terminal);
		}

		assert.deepStrictEqual(terminal.getViewport(), await fullRenderViewport(lines));
		tui.stop();
	});
});
