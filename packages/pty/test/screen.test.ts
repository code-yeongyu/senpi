import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { TerminalScreen } from "../src/screen.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("TerminalScreen", () => {
	it("captures ANSI visible lines as plain visible grid text", async () => {
		const screen = new TerminalScreen({ cols: 10, rows: 3, scrollback: 10 });
		await screen.feed(bytes("\x1b[31mred\x1b[0m\r\nplain"));

		const snapshot = screen.snapshot();

		expect(snapshot.visibleGrid).toEqual(["red", "plain", ""]);
		expect(snapshot.cursor).toEqual({ x: 5, y: 1 });
	});

	it("tracks cursor moves and clear-line sequences", async () => {
		const screen = new TerminalScreen({ cols: 12, rows: 4, scrollback: 10 });
		await screen.feed(bytes("alpha\r\nbeta\r\ncharlie"));
		await screen.feed(bytes("\x1b[2;1H\x1b[2Kdone"));

		const snapshot = screen.snapshot();

		expect(snapshot.visibleGrid).toEqual(["alpha", "done", "charlie", ""]);
		expect(snapshot.cursor).toEqual({ x: 4, y: 1 });
	});

	it("reflows wrapped lines when resized", async () => {
		const screen = new TerminalScreen({ cols: 6, rows: 4, scrollback: 10 });
		await screen.feed(bytes("abcdefghi"));
		await screen.resize(3, 4);

		const snapshot = screen.snapshot();

		expect(snapshot.cols).toBe(3);
		expect(snapshot.visibleGrid).toEqual(["abc", "def", "ghi", ""]);
	});

	it("caps scrollback in snapshots", async () => {
		const screen = new TerminalScreen({ cols: 8, rows: 2, scrollback: 3 });
		await screen.feed(bytes("l1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6"));

		const snapshot = screen.snapshot();

		expect(snapshot.scrollback).toEqual(["l2", "l3", "l4"]);
		expect(snapshot.visibleGrid).toEqual(["l5", "l6"]);
	});

	it("sanitizes malformed UTF-8 bytes without throwing", async () => {
		const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 10 });
		await screen.feed(new Uint8Array([0x6f, 0x6b, 0x20, 0xe2, 0x28, 0xa1]));

		const snapshot = screen.snapshot();

		expect(snapshot.visibleGrid[0]).toBe("ok \uFFFD(\uFFFD");
		expect(snapshot.visibleGrid[0]).not.toContain("\u0000");
	});

	it("falls back to a sanitized write when xterm rejects malformed text", async () => {
		const originalWrite = xterm.Terminal.prototype.write;
		const writes: string[] = [];
		let rejectedRawPayload = false;

		xterm.Terminal.prototype.write = function patchedWrite(
			this: XtermTerminalType,
			data: string | Uint8Array,
			callback?: () => void,
		): void {
			const payload = typeof data === "string" ? data : new TextDecoder().decode(data);
			writes.push(payload);
			if (!rejectedRawPayload && payload.includes("\ud800")) {
				rejectedRawPayload = true;
				throw new Error("mock xterm malformed text rejection");
			}
			originalWrite.call(this, data, callback);
		};

		try {
			const screen = new TerminalScreen({ cols: 20, rows: 2, scrollback: 10 });
			await screen.feed("ok \ud800");

			const snapshot = screen.snapshot();

			expect(rejectedRawPayload).toBe(true);
			expect(writes).toContain("ok \ud800");
			expect(writes).toContain("ok \uFFFD");
			expect(snapshot.visibleGrid[0]).toBe("ok \uFFFD");
		} finally {
			xterm.Terminal.prototype.write = originalWrite;
		}
	});

	it("bounds resize replay history in long sessions", async () => {
		const originalWrite = xterm.Terminal.prototype.write;
		const replayLengths: number[] = [];
		let capturingResizeReplay = false;

		xterm.Terminal.prototype.write = function patchedWrite(
			this: XtermTerminalType,
			data: string | Uint8Array,
			callback?: () => void,
		): void {
			if (capturingResizeReplay) {
				replayLengths.push(typeof data === "string" ? data.length : data.byteLength);
			}
			originalWrite.call(this, data, callback);
		};

		try {
			const screen = new TerminalScreen({ cols: 12, rows: 2, scrollback: 2 });
			for (let index = 0; index < 1200; index += 1) {
				await screen.feed(bytes(`line-${String(index).padStart(4, "0")}\r\n`));
			}

			capturingResizeReplay = true;
			await screen.resize(12, 2);

			const snapshot = screen.snapshot();

			expect(Math.max(...replayLengths)).toBeLessThanOrEqual(4096);
			expect(snapshot.visibleGrid).toEqual(["line-1199", ""]);
			expect(snapshot.scrollback).toEqual(["line-1197", "line-1198"]);
		} finally {
			xterm.Terminal.prototype.write = originalWrite;
		}
	});
});
