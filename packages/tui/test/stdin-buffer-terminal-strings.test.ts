import assert from "node:assert/strict";
import { beforeEach, describe, it, type TestContext } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";

// senpi#4352: a Kitty graphics delete APC echoed back by the terminal reached the prompt as
// `Ga=d,d=I,i=1578415760,q=2`. The flush timer released the head of the string sequence before its
// tail was read, and the tail was framed as typed characters.
const APC = "\x1b_Ga=d,d=I,i=1578415760,q=2\x1b\\";
const APC_8BIT = "\u009fGa=d,d=I,i=1578415760,q=2\u009c";
const FLUSH_TICK_MS = 100;

type Capture = { buffer: StdinBuffer; data: string[]; pastes: string[] };

function capture(): Capture {
	const buffer = new StdinBuffer();
	const data: string[] = [];
	const pastes: string[] = [];
	buffer.on("data", (sequence) => data.push(sequence));
	buffer.on("paste", (content) => pastes.push(content));
	return { buffer, data, pastes };
}

function typed(sequences: readonly string[]): string {
	return sequences.filter((sequence) => !sequence.startsWith("\x1b")).join("");
}

function feed(t: TestContext, { buffer }: Capture, parts: readonly string[], flushBetween: boolean): void {
	for (const part of parts) {
		buffer.process(part);
		if (flushBetween) t.mock.timers.tick(FLUSH_TICK_MS);
	}
}

function assertOnlyKeyAfter(t: TestContext, input: Capture, parts: readonly string[], flushBetween: boolean): void {
	feed(t, input, parts, flushBetween);
	feed(t, input, ["x"], true);
	assert.equal(typed(input.data), "x", `split ${JSON.stringify(parts)} flush=${flushBetween}`);
	assert.deepEqual(input.pastes, []);
}

describe("StdinBuffer terminal string sequences (#4352)", () => {
	beforeEach((t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	});

	for (const [label, sequence] of [
		["7-bit APC", APC],
		["8-bit APC", APC_8BIT],
	] as const) {
		it(`${label} in one read reaches no prompt text`, (t) => {
			assertOnlyKeyAfter(t, capture(), [sequence], true);
		});

		it(`${label} split at every boundary reaches no prompt text, even when the flush timer fires mid-sequence`, (t) => {
			for (const flushBetween of [false, true]) {
				for (let cut = 1; cut < sequence.length; cut++) {
					assertOnlyKeyAfter(t, capture(), [sequence.slice(0, cut), sequence.slice(cut)], flushBetween);
				}
			}
		});
	}

	it("APC whose introducer, body pieces and terminator arrive in separate late reads reaches no prompt text", (t) => {
		assertOnlyKeyAfter(t, capture(), ["\x1b_", "Ga=d,d=I", ",i=1578415760,q=2", "\x1b", "\\"], true);
	});

	it("APC whose ESC was held past the escape window before its timer ran reaches no prompt text", () => {
		let clock = 0;
		const buffer = new StdinBuffer({ now: () => clock });
		const data: string[] = [];
		buffer.on("data", (sequence) => data.push(sequence));
		buffer.process("\x1b");
		clock += FLUSH_TICK_MS;
		buffer.process(APC.slice(1));
		assert.equal(typed(data), "");
	});

	it("keeps single keystrokes after a legacy Alt+_ or Escape press", (t) => {
		const altUnderscore = capture();
		feed(t, altUnderscore, ["\x1b_", "x"], true);
		assert.deepEqual(altUnderscore.data, ["\x1b_", "x"]);

		const escape = capture();
		feed(t, escape, ["\x1b", "_"], true);
		assert.deepEqual(escape.data, ["\x1b", "_"]);
	});
});
