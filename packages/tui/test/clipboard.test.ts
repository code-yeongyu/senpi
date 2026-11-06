import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeClipboardOsc52 } from "../src/clipboard.ts";

// #4263: byte-level OSC 52 transport; every tty opener is injected, never /dev/tty.
describe("clipboard OSC 52 transport", () => {
	for (const tmux of [false, true]) {
		it(`writes ${tmux ? "tmux passthrough" : "plain OSC 52"} to tty instead of redirected stdout`, () => {
			const ttyWrites: string[] = [];
			const stdout: string[] = [];
			let closed = 0;
			writeClipboardOsc52("hello", {
				platform: "linux",
				env: tmux ? { TMUX: "/tmux,1,0" } : {},
				write: (data) => {
					stdout.push(data);
				},
				openTty: () => ({
					write: (data) => {
						ttyWrites.push(data);
					},
					close: () => {
						closed++;
					},
				}),
			});
			assert.deepEqual(ttyWrites, [tmux ? "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\" : "\x1b]52;c;aGVsbG8=\x07"]);
			assert.deepEqual(stdout, []);
			assert.equal(closed, 1);
		});
		it(`falls back to stdout with ${tmux ? "tmux passthrough" : "plain OSC 52"} when tty is unavailable`, () => {
			const stdout: string[] = [];
			writeClipboardOsc52("hello", {
				platform: "linux",
				env: tmux ? { TMUX: "/tmux,1,0" } : {},
				write: (data) => {
					stdout.push(data);
				},
				openTty: () => {
					throw new Error("no tty");
				},
			});
			assert.deepEqual(stdout, [tmux ? "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\" : "\x1b]52;c;aGVsbG8=\x07"]);
		});
	}
	it("closes the tty after a failed write before falling back", () => {
		const events: string[] = [];
		writeClipboardOsc52("hello", {
			platform: "linux",
			env: {},
			write: (data) => {
				events.push(data);
			},
			openTty: () => ({
				write: () => {
					throw new Error("tty disconnected");
				},
				close: () => {
					events.push("closed");
				},
			}),
		});
		assert.deepEqual(events, ["closed", "\x1b]52;c;aGVsbG8=\x07"]);
	});
	it("uses stdout on Windows without attempting to open a tty", () => {
		const events: string[] = [];
		writeClipboardOsc52("hello", {
			platform: "win32",
			env: {},
			write: (data) => {
				events.push(data);
			},
			openTty: () => {
				assert.fail("Windows must not open /dev/tty");
			},
		});
		assert.deepEqual(events, ["\x1b]52;c;aGVsbG8=\x07"]);
	});
});
