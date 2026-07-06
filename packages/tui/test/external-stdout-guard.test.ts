import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.ts";

interface GuardHarness {
	terminal: ProcessTerminal;
	writes: string[];
	hidden: string[];
	stubbedWrite: typeof process.stdout.write;
	cleanup(): void;
}

function setupGuardHarness(options?: { withHandler?: boolean; handler?: (text: string) => void }): GuardHarness {
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

	const stubbedWrite = ((chunk: string | Uint8Array) => {
		writes.push(String(chunk));
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
