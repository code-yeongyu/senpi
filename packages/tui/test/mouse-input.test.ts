import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decodeMouseButton,
	isMouseSequence,
	MouseClickSynthesizer,
	parseSgrMouseEvent,
	parseWheelEvent,
	toTuiMouseEvent,
} from "../src/mouse-input.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("shared mouse input (#1645)", () => {
	for (const [sequence, expected] of [
		["\x1b[<0;10;5M", { button: 0, x: 9, y: 4, release: false }],
		["\x1b[<0;10;5m", { button: 0, x: 9, y: 4, release: true }],
		["\x1b[<64;3;3M", { button: 64, x: 2, y: 2, release: false }],
		["\x1b[<35;20;5M", { button: 35, x: 19, y: 4, release: false }],
	] as const)
		it(`parses ${JSON.stringify(sequence)}`, () => assert.deepEqual(parseSgrMouseEvent(sequence), expected));
	it("rejects out-of-range protocol values", () => {
		for (const sequence of ["\x1b[<256;1;1M", "\x1b[<0;0;1M", "text"])
			assert.equal(parseSgrMouseEvent(sequence), undefined);
	});
	it("decodes buttons and modifiers", () => {
		assert.deepEqual([0, 1, 2, 3].map(decodeMouseButton), ["left", "middle", "right", "none"]);
		for (const bit of [4, 8, 16]) {
			const event = toTuiMouseEvent("press", { button: bit, x: 9, y: 4, release: false }, { columns: 80, rows: 24 });
			assert.equal(event?.shift, bit === 4);
			assert.equal(event?.alt, bit === 8);
			assert.equal(event?.ctrl, bit === 16);
		}
	});
	it("recognizes and parses wheel protocols", () => {
		assert.deepEqual(parseWheelEvent("\x1b[<64;3;3M"), { direction: -1, x: 2, y: 2, button: 64 });
		assert.deepEqual(parseWheelEvent("\x1b[<65;3;3M"), { direction: 1, x: 2, y: 2, button: 65 });
		assert.equal(isMouseSequence("\x1b[<0;1;1M"), true);
		assert.equal(isMouseSequence("\x1b[M !!"), true);
		assert.equal(isMouseSequence("a"), false);
	});
	it("reassembles split reads before keyboard handling", () => {
		// StdinBuffer, not the stateless parser, owns transport reassembly.
		const buffer = new StdinBuffer();
		const seen: string[] = [];
		buffer.on("data", (sequence) => seen.push(sequence));
		buffer.process("\x1b[<0;1");
		assert.deepEqual(seen, []);
		buffer.process("0;5M");
		assert.deepEqual(seen, ["\x1b[<0;10;5M"]);
		assert.deepEqual(parseSgrMouseEvent(seen[0]), { button: 0, x: 9, y: 4, release: false });
		buffer.destroy();
	});
	it("keeps owned fragments out of keyboard handling after timeout flush", () => {
		const buffer = new StdinBuffer();
		const seen: string[] = [];
		buffer.on("data", (sequence) => seen.push(sequence));
		buffer.process("\x1b[<0;1");
		assert.deepEqual(buffer.flush(), []);
		buffer.process("0;5M");
		assert.deepEqual(seen, ["\x1b[<0;10;5M"]);
		buffer.destroy();
	});
	it("bounds owned fragment buffering and discards late tails", (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		const buffer = new StdinBuffer();
		const seen: string[] = [];
		buffer.on("data", (sequence) => seen.push(sequence));
		buffer.process("\x1b[<0;1");
		t.mock.timers.tick(750);
		assert.equal(buffer.getBuffer(), "");
		assert.deepEqual(seen, []);
		buffer.process("0;5Ma");
		assert.deepEqual(seen, ["a"]);
		buffer.process(`\x1b[<${"1".repeat(65)}`);
		assert.equal(buffer.getBuffer(), "");
		buffer.process(";1;1Mb");
		assert.deepEqual(seen, ["a", "b"]);
		buffer.destroy();
	});
	it("resynchronizes at a new escape without leaking its protocol tail", () => {
		const buffer = new StdinBuffer();
		const seen: string[] = [];
		buffer.on("data", (sequence) => seen.push(sequence));
		buffer.process(`\x1b[<${"1".repeat(65)}`);
		buffer.process("\x1b[<0;10;5M");
		assert.deepEqual(seen, ["\x1b[<0;10;5M"]);
		buffer.destroy();
	});
	it("synthesizes click chains with explicit time", () => {
		const s = new MouseClickSynthesizer();
		const target = {};
		const raw = { button: 0, x: 4, y: 2, release: false };
		for (let i = 0; i < 4; i++) {
			s.press(raw, target, 1, 100 * i);
			assert.equal(s.release({ ...raw, release: true }, target, 1, 100 * i + 1), (i % 3) + 1);
		}
		s.press(raw, target, 1, 1000);
		assert.equal(s.release({ ...raw, release: true }, target, 1, 1001), 1);
	});
	it("rejects stale, moved, cancelled and retargeted gestures", () => {
		const s = new MouseClickSynthesizer();
		const target = {};
		const raw = { button: 0, x: 4, y: 2, release: false };
		for (const [release, identity, epoch, time] of [
			[{ ...raw, x: 5 }, target, 1, 1],
			[raw, {}, 1, 1],
			[raw, target, 2, 1],
			[raw, target, 1, 501],
		] as const) {
			s.press(raw, target, 1, 0);
			assert.equal(s.release(release, identity, epoch, time), undefined);
		}
		s.press(raw, target, 1, 0);
		s.cancel();
		assert.equal(s.release(raw, target, 1, 1), undefined);
	});
});
