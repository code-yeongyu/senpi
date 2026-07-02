import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { type Component, TUI } from "../src/tui.ts";
import { coalesceAdjacentSgr } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

interface CellSnapshot {
	readonly chars: string;
	readonly width: number;
	readonly fgMode: number;
	readonly fgColor: number;
	readonly bgMode: number;
	readonly bgColor: number;
	readonly bold: number;
	readonly dim: number;
	readonly italic: number;
	readonly underline: number;
	readonly blink: number;
	readonly inverse: number;
	readonly invisible: number;
	readonly strikethrough: number;
}

interface Report {
	readonly adopted: boolean;
}

class TestComponent implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

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
}

function isXtermTerminal(value: unknown): value is XtermTerminalType {
	return typeof value === "object" && value !== null && "buffer" in value;
}

function getXterm(terminal: VirtualTerminal): XtermTerminalType {
	const value: unknown = Reflect.get(terminal, "xterm");
	if (!isXtermTerminal(value)) {
		throw new Error("VirtualTerminal should expose an xterm instance in tests");
	}
	return value;
}

async function renderLine(line: string): Promise<readonly CellSnapshot[]> {
	const terminal = new VirtualTerminal(96, 3);
	terminal.write(`${line}\x1b[0m`);
	await terminal.flush();
	const xterm = getXterm(terminal);
	const buffer = xterm.buffer.active;
	const row = buffer.getLine(buffer.viewportY);
	if (!row) {
		throw new Error("expected first row");
	}
	const cells: CellSnapshot[] = [];
	for (let col = 0; col < xterm.cols; col++) {
		const cell = row.getCell(col);
		if (!cell) {
			throw new Error(`expected cell ${col}`);
		}
		cells.push({
			chars: cell.getChars(),
			width: cell.getWidth(),
			fgMode: cell.getFgColorMode(),
			fgColor: cell.getFgColor(),
			bgMode: cell.getBgColorMode(),
			bgColor: cell.getBgColor(),
			bold: cell.isBold(),
			dim: cell.isDim(),
			italic: cell.isItalic(),
			underline: cell.isUnderline(),
			blink: cell.isBlink(),
			inverse: cell.isInverse(),
			invisible: cell.isInvisible(),
			strikethrough: cell.isStrikethrough(),
		});
	}
	return cells;
}

function readReport(): Report {
	const raw = readFileSync(new URL("../bench/sgr-coalesce-report.json", import.meta.url), "utf8");
	const value: unknown = JSON.parse(raw);
	if (!hasBooleanAdopted(value)) {
		throw new Error("report should contain adopted boolean");
	}
	return value;
}

function hasBooleanAdopted(value: unknown): value is Report {
	return typeof value === "object" && value !== null && "adopted" in value && typeof value.adopted === "boolean";
}

const semanticCorpus = [
	"\x1b[31m\x1b[1mred bold\x1b[0m plain",
	"\x1b[1m\x1b[31mred bold reversed order\x1b[22m\x1b[39m",
	"\x1b[38;5;196m\x1b[48;5;16m256 color\x1b[0m",
	"\x1b[38;2;10;20;30m\x1b[48;2;240;230;220mtruecolor\x1b[0m",
	"\x1b[4m\x1b[24munderline reset before text",
	"\x1b[3mitalic \x1b[23mplain",
	"\x1b[1;31m\x1b[44mnested colors\x1b[0m",
	"\x1b[31mred\x1b[39m default \x1b[32mgreen\x1b[0m",
	"\x1b[48;5;22mbackground\x1b[49m default",
	"\x1b[2m\x1b[22mdim reset",
	"\x1b[7m\x1b[27minverse reset",
	"\x1b[9m\x1b[29mstrike reset",
	"\x1b[5m\x1b[25mblink reset",
	"\x1b[8m\x1b[28mhidden reset",
	"\x1b[0m\x1b[31mreset then red",
	"\x1b[m\x1b[32mempty reset then green",
	"\x1b[38;5;240mgray \x1b[38;5;241mgray2\x1b[0m",
	"\x1b[38;2;1;2;3mfg \x1b[48;2;4;5;6mbg\x1b[0m",
	"\x1b[1m\x1b[3m\x1b[4mmany attrs\x1b[0m",
	"plain \x1b[31mred\x1b[0m tail",
	"\x1b]8;;https://example.com\x07\x1b[34mlink\x1b[0m\x1b]8;;\x07",
	"\x1b]8;;https://example.com\x1b\\\x1b[34mlink st\x1b[0m\x1b]8;;\x1b\\",
	"\x1b]8;id=1;https://example.com\x07\x1b[1mparam link\x1b[0m\x1b]8;;\x07",
	"\x1b[31m\x1b]8;;https://example.com\x07mixed\x1b]8;;\x07\x1b[0m",
	"terminator \x1b]8;;https://example.com\x07x\x1b]8;;\x07 \x1b[32mgreen\x1b[0m",
	"\x1b[31mred\x1b[0m\x1b[2K\x1b[0m\x1b]8;;\x07clear guard",
	"\x1b[31mred\x1b[39m\x1b[0mreset-heavy",
	"\x1b[1mwide 漢字\x1b[22m tail",
	"\x1b[38;5;33memoji 😀\x1b[0m tail",
	"\x1b[31m\x1b[44mcombo \x1b[49mfg-only\x1b[39m",
] as const;

describe("coalesceAdjacentSgr", () => {
	it("merges immediately adjacent SGR sequences exactly", () => {
		const cases = [
			{ input: "\x1b[31m\x1b[1mred", expected: "\x1b[31;1mred" },
			{ input: "a\x1b[38;5;196m\x1b[48;5;16mb", expected: "a\x1b[38;5;196;48;5;16mb" },
			{ input: "\x1b[38;2;1;2;3m\x1b[48;2;4;5;6mtrue", expected: "\x1b[38;2;1;2;3;48;2;4;5;6mtrue" },
			{ input: "\x1b[m\x1b[31mempty-reset", expected: "\x1b[0;31mempty-reset" },
			{ input: "\x1b[31mtext\x1b[1m", expected: "\x1b[31mtext\x1b[1m" },
			{ input: "\x1b[2K\x1b[0m\x1b]8;;\x07", expected: "\x1b[2K\x1b[0m\x1b]8;;\x07" },
		] as const;

		for (const { input, expected } of cases) {
			assert.strictEqual(coalesceAdjacentSgr(input), expected);
		}
	});

	it("is a virtual-terminal semantic no-op for the SGR/OSC corpus", async () => {
		assert.strictEqual(semanticCorpus.length, 30);
		for (const line of semanticCorpus) {
			const original = await renderLine(line);
			const coalesced = await renderLine(coalesceAdjacentSgr(line));
			assert.deepStrictEqual(coalesced, original, JSON.stringify(line));
		}
	});

	it("is idempotent", () => {
		for (const line of semanticCorpus) {
			const once = coalesceAdjacentSgr(line);
			assert.strictEqual(coalesceAdjacentSgr(once), once, JSON.stringify(line));
		}
	});

	it("emit-path wiring matches report.adopted", async () => {
		const report = readReport();
		const original = "\x1b[31m\x1b[1mcoalesce-probe";
		const coalesced = "\x1b[31;1mcoalesce-probe";
		const terminal = new LoggingVirtualTerminal(60, 4);
		const tui = new TUI(terminal);
		const component = new TestComponent([original]);
		tui.addChild(component);

		try {
			tui.start();
			await terminal.waitForRender();
			const writes = terminal.getWrites();
			if (report.adopted) {
				assert.ok(writes.includes(coalesced), "adopted report should emit coalesced SGR bytes");
				assert.ok(!writes.includes(original), "adopted report should not emit original adjacent SGR bytes");
			} else {
				assert.ok(writes.includes(original), "non-adopted report should emit original adjacent SGR bytes");
				assert.ok(!writes.includes(coalesced), "non-adopted report should not emit coalesced SGR bytes");
			}
		} finally {
			tui.stop();
		}
	});
});
