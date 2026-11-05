import assert from "node:assert";
import { once } from "node:events";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.ts";

interface GuardHarness {
	terminal: ProcessTerminal;
	writes: string[];
	hidden: string[];
	stubbedWrite: typeof process.stdout.write;
	cleanup(): void;
}

function setupGuardHarness(options?: {
	withHandler?: boolean;
	handler?: (text: string) => void;
	write?: (text: string, callback?: (error?: Error | null) => void, encoding?: BufferEncoding) => boolean;
}): GuardHarness {
	const writes: string[] = [];
	const hidden: string[] = [];
	const previousWrite = process.stdout.write;
	const previousStdinOn = process.stdin.on;
	const previousResume = process.stdin.resume;
	const previousPause = process.stdin.pause;
	const previousEnv = new Map<string, string | undefined>();
	for (const name of ["PI_TUI_KEYBOARD_PROTOCOL", "TMUX", "TMUX_PANE", "PI_TUI_WRITE_LOG"]) {
		previousEnv.set(name, process.env[name]);
		delete process.env[name];
	}
	process.env.PI_TUI_KEYBOARD_PROTOCOL = "0";

	const stubbedWrite = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	) => {
		const text = String(chunk);
		writes.push(text);
		const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
		if (options?.write) return options.write(text, cb, encoding);
		cb?.(null);
		return true;
	}) as typeof process.stdout.write;
	process.stdout.write = stubbedWrite;
	process.stdin.on = ((_event: string | symbol, _listener: (...args: unknown[]) => void) =>
		process.stdin) as typeof process.stdin.on;
	process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
	process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;

	const handler = options?.handler ?? ((text: string) => hidden.push(text));
	const terminal = new ProcessTerminal(
		options?.withHandler === false ? undefined : { onExternalStdoutWrite: handler },
	);

	let cleaned = false;
	return {
		terminal,
		writes,
		hidden,
		stubbedWrite,
		cleanup(): void {
			if (cleaned) return;
			cleaned = true;
			try {
				terminal.stop();
			} finally {
				process.stdout.write = previousWrite;
				process.stdin.on = previousStdinOn;
				process.stdin.resume = previousResume;
				process.stdin.pause = previousPause;
				for (const [name, value] of previousEnv) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
			}
		},
	};
}

describe("ProcessTerminal external stdout guard", () => {
	for (const encoding of ["base64", "utf16le"] as const) {
		it(`emits the checked clipboard bytes with caller encoding ${encoding}`, () => {
			const frame = "\x1b]52;c;YQ==\x07";
			const chunks: Buffer[] = [];
			const sink = new Writable({
				write(chunk, _encoding, callback) {
					chunks.push(Buffer.from(chunk));
					callback();
				},
			});
			const harness = setupGuardHarness({
				write: (text, cb, writeEncoding) => sink.write(text, writeEncoding ?? "utf8", cb),
			});
			try {
				harness.terminal.start(
					() => {},
					() => {},
				);
				chunks.length = 0;

				process.stdout.write(frame, encoding);

				assert.deepEqual(Buffer.concat(chunks), Buffer.from(frame, "utf8"));
				assert.deepEqual(harness.hidden, []);
			} finally {
				harness.cleanup();
				sink.destroy();
			}
		});
	}

	for (const payload of ["", "a", "ab", "abc", "h\u00e9llo\n\u4e16\u754c"]) {
		for (const buffer of [false, true]) {
			it(`delivers clipboard writes for ${JSON.stringify(payload)} as ${buffer ? "Buffer" : "string"}`, () => {
				const harness = setupGuardHarness();
				try {
					harness.terminal.start(
						() => {},
						() => {},
					);
					harness.writes.length = 0;
					const frame = `\x1b]52;c;${Buffer.from(payload).toString("base64")}\x07`;

					process.stdout.write(buffer ? Buffer.from(frame) : frame);

					assert.deepEqual(harness.writes, [frame]);
					assert.deepEqual(harness.hidden, []);
				} finally {
					harness.cleanup();
				}
			});
		}
	}

	for (const text of [
		"visible\x1b]52;c;YQ==\x07",
		"\x1b]52;c;YQ==\x07visible",
		"\x1b]52;c;YQ==\x07\n",
		"\x1b]52;c;?\x07",
		"\x1b]52;c;YQ==",
		"\x1b]52;c;not base64\x07",
		"ordinary external stdout\n",
	]) {
		it(`hides non-clipboard-only output ${JSON.stringify(text)}`, () => {
			const harness = setupGuardHarness();
			try {
				harness.terminal.start(
					() => {},
					() => {},
				);
				harness.writes.length = 0;

				process.stdout.write(text);

				assert.deepEqual(harness.writes, []);
				assert.deepEqual(harness.hidden, [text]);
			} finally {
				harness.cleanup();
			}
		});
	}

	for (const encoding of [undefined, "utf8"] as const) {
		it(`preserves clipboard writer completion and backpressure with encoding ${encoding}`, async () => {
			const frame = "\x1b]52;c;YQ==\x07";
			let complete: ((error?: Error | null) => void) | undefined;
			const sink = new Writable({
				highWaterMark: 1,
				write(chunk, _encoding, callback) {
					if (String(chunk) === frame) complete = callback;
					else callback();
				},
			});
			const harness = setupGuardHarness({ write: (text, cb) => sink.write(text, cb) });
			try {
				harness.terminal.start(
					() => {},
					() => {},
				);
				let acknowledged = false;
				const drained = once(sink, "drain", { signal: AbortSignal.timeout(1000) }).then(
					(events) => events,
					(error: unknown) => error,
				);
				const callback = (error?: Error | null) => {
					assert.ifError(error);
					acknowledged = true;
				};

				const accepted = encoding
					? process.stdout.write(frame, encoding, callback)
					: process.stdout.write(frame, callback);

				assert.equal(accepted, false);
				assert.equal(acknowledged, false);
				assert.ok(complete);
				complete();
				assert.deepEqual(await drained, []);
				assert.equal(acknowledged, true);
			} finally {
				harness.cleanup();
				sink.destroy();
			}
		});
	}

	it("delivers the underlying clipboard writer error without an early success callback", async () => {
		const frame = "\x1b]52;c;YQ==\x07";
		const failure = new Error("clipboard stream failed");
		let complete: ((error?: Error | null) => void) | undefined;
		const sink = new Writable({
			write(chunk, _encoding, callback) {
				if (String(chunk) === frame) complete = callback;
				else callback();
			},
		});
		const harness = setupGuardHarness({ write: (text, cb) => sink.write(text, cb) });
		try {
			harness.terminal.start(
				() => {},
				() => {},
			);
			const errors = once(sink, "error", { signal: AbortSignal.timeout(1000) }).then(
				(events) => events,
				(error: unknown) => error,
			);
			const acknowledgments: (Error | null | undefined)[] = [];

			process.stdout.write(frame, (error) => acknowledgments.push(error));

			assert.deepEqual(acknowledgments, []);
			assert.ok(complete);
			complete(failure);
			assert.deepEqual(await errors, [failure]);
			assert.deepEqual(acknowledgments, [failure]);
		} finally {
			harness.cleanup();
			sink.destroy();
		}
	});

	it("hides external stdout writes while started and forwards them to the handler", () => {
		const harness = setupGuardHarness();
		try {
			harness.terminal.start(
				() => {},
				() => {},
			);
			harness.writes.length = 0;

			process.stdout.write("external junk\n");

			assert.deepEqual(harness.hidden, ["external junk\n"]);
			assert.equal(
				harness.writes.some((chunk) => chunk.includes("external junk")),
				false,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("lets the terminal's own writes reach stdout while the guard is active", () => {
		const harness = setupGuardHarness();
		try {
			harness.terminal.start(
				() => {},
				() => {},
			);
			harness.writes.length = 0;

			harness.terminal.write("\x1b[?2026hframe\x1b[?2026l");
			harness.terminal.setProgress(true);
			harness.terminal.setProgress(false);
			harness.terminal.hideCursor();

			assert.equal(
				harness.writes.some((chunk) => chunk.includes("frame")),
				true,
			);
			assert.equal(
				harness.writes.some((chunk) => chunk.includes("\x1b]9;4;3\x07")),
				true,
			);
			assert.equal(
				harness.writes.some((chunk) => chunk.includes("\x1b[?25l")),
				true,
			);
			assert.deepEqual(harness.hidden, []);
		} finally {
			harness.cleanup();
		}
	});

	it("captures console.log while started", () => {
		const harness = setupGuardHarness();
		try {
			harness.terminal.start(
				() => {},
				() => {},
			);
			harness.writes.length = 0;

			console.log("stray library log");

			assert.equal(
				harness.hidden.some((text) => text.includes("stray library log")),
				true,
			);
			assert.equal(
				harness.writes.some((chunk) => chunk.includes("stray library log")),
				false,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("decodes Buffer chunks before forwarding", () => {
		const harness = setupGuardHarness();
		try {
			harness.terminal.start(
				() => {},
				() => {},
			);
			harness.writes.length = 0;

			process.stdout.write(Buffer.from("binary chunk"));

			assert.deepEqual(harness.hidden, ["binary chunk"]);
		} finally {
			harness.cleanup();
		}
	});

	it("restores passthrough after stop()", () => {
		const harness = setupGuardHarness();
		try {
			harness.terminal.start(
				() => {},
				() => {},
			);
			harness.terminal.stop();
			harness.writes.length = 0;

			process.stdout.write("after stop\n");

			assert.equal(
				harness.writes.some((chunk) => chunk.includes("after stop")),
				true,
			);
			assert.deepEqual(harness.hidden, []);
		} finally {
			harness.cleanup();
		}
	});

	it("does not patch stdout when no handler is configured", () => {
		const harness = setupGuardHarness({ withHandler: false });
		try {
			harness.terminal.start(
				() => {},
				() => {},
			);
			assert.equal(process.stdout.write, harness.stubbedWrite);
			harness.writes.length = 0;

			process.stdout.write("plain passthrough\n");

			assert.equal(
				harness.writes.some((chunk) => chunk.includes("plain passthrough")),
				true,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to raw stdout when the handler throws", () => {
		const harness = setupGuardHarness({
			handler: () => {
				throw new Error("handler exploded");
			},
		});
		try {
			harness.terminal.start(
				() => {},
				() => {},
			);
			harness.writes.length = 0;

			process.stdout.write("must not vanish\n");

			assert.equal(
				harness.writes.some((chunk) => chunk.includes("must not vanish")),
				true,
			);
		} finally {
			harness.cleanup();
		}
	});
});
