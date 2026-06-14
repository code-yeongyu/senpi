import assert from "node:assert";
import { mock, describe as nodeDescribe, it as nodeIt } from "node:test";
import { vi, describe as vitestDescribe, it as vitestIt } from "vitest";
import { setKittyProtocolActive } from "../src/keys.ts";
import { keyboardEnhancementEnabled, normalizeAppleTerminalInput, ProcessTerminal } from "../src/terminal.ts";

const isVitest = process.env.VITEST === "true";
type TestCallback = () => void | Promise<void>;

function describe(name: string, fn: TestCallback): void {
	if (isVitest) {
		vitestDescribe(name, fn);
		return;
	}
	nodeDescribe(name, fn);
}

function it(name: string, fn: TestCallback): void {
	if (isVitest) {
		vitestIt(name, fn);
		return;
	}
	nodeIt(name, fn);
}

function enableFakeTimers(): void {
	if (isVitest) {
		vi.useFakeTimers();
		return;
	}
	mock.timers.enable({ apis: ["setTimeout"] });
}

function advanceTimersByTime(ms: number): void {
	if (isVitest) {
		vi.advanceTimersByTime(ms);
		return;
	}
	mock.timers.tick(ms);
}

function resetFakeTimers(): void {
	if (isVitest) {
		vi.useRealTimers();
		return;
	}
	mock.timers.reset();
}

describe("normalizeAppleTerminalInput", () => {
	it("rewrites Apple Terminal Return to CSI-u Shift+Enter when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Apple Terminal Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, false), "\r");
	});

	it("leaves non-Apple Terminal Return unchanged when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", false, true), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeAppleTerminalInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeAppleTerminalInput("a", true, true), "a");
	});
});

describe("ProcessTerminal Kitty keyboard protocol negotiation", () => {
	type NegotiationHarness = {
		terminal: ProcessTerminal;
		writes: string[];
		send(data: string | Buffer): void;
		getInput(): string | undefined;
		cleanup(): void;
	};

	function setupNegotiation(env: Record<string, string | undefined> = {}): NegotiationHarness {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		let input: string | undefined;
		let dataHandler: ((data: string | Buffer) => void) | undefined;
		let cleaned = false;
		const previousWrite = process.stdout.write;
		const previousOn = process.stdin.on;
		const previousEnv = new Map<string, string | undefined>();
		const effectiveEnv = { PI_TUI_KEYBOARD_PROTOCOL: undefined, TMUX: undefined, TMUX_PANE: undefined, ...env };

		for (const [name, value] of Object.entries(effectiveEnv)) {
			previousEnv.set(name, process.env[name]);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "data") dataHandler = listener as (data: string | Buffer) => void;
			return process.stdin;
		}) as typeof process.stdin.on;

		(
			terminal as unknown as {
				inputHandler?: (data: string) => void;
				queryAndEnableKittyProtocol(): void;
			}
		).inputHandler = (data) => {
			input = data;
		};
		(terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

		return {
			terminal,
			writes,
			send(data: string | Buffer): void {
				dataHandler?.(data);
			},
			getInput(): string | undefined {
				return input;
			},
			cleanup(): void {
				if (cleaned) return;
				cleaned = true;
				try {
					terminal.stop();
				} finally {
					for (const [name, value] of previousEnv) {
						if (value === undefined) delete process.env[name];
						else process.env[name] = value;
					}
					process.stdout.write = previousWrite;
					process.stdin.on = previousOn;
					setKittyProtocolActive(false);
				}
			},
		};
	}

	it("queries Kitty mode before enabling modifyOtherKeys fallback", () => {
		const harness = setupNegotiation();
		try {
			assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("activates Kitty mode for non-zero negotiated flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[<u").length, 1);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for zero Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?0u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;0m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for device attributes without Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?62;4;52c");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("forwards normal input while waiting for Kitty response", () => {
		const harness = setupNegotiation();
		try {
			harness.send("a");

			assert.equal(harness.getInput(), "a");
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("reassembles split Korean Buffer chunks before forwarding input", () => {
		const harness = setupNegotiation();
		try {
			harness.send(Buffer.from([0xed, 0x95]));
			assert.equal(harness.getInput(), undefined);

			harness.send(Buffer.from([0x9c]));

			assert.equal(harness.getInput(), "한");
		} finally {
			harness.cleanup();
		}
	});

	it("tracks split Kitty confirmation", () => {
		enableFakeTimers();
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7");
			advanceTimersByTime(10);

			assert.equal(harness.getInput(), undefined);

			harness.send("u");

			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
		} finally {
			harness.cleanup();
			resetFakeTimers();
		}
	});

	it("replays buffered CSI-prefix input when it is not a Kitty response", () => {
		enableFakeTimers();
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[");
			advanceTimersByTime(10);

			assert.equal(harness.getInput(), undefined);

			advanceTimersByTime(150);

			assert.equal(harness.getInput(), "\x1b[");
		} finally {
			harness.cleanup();
			resetFakeTimers();
		}
	});

	it("requests modifyOtherKeys immediately when running inside tmux", () => {
		const harness = setupNegotiation({ TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%1" });
		try {
			const modifyOtherKeysIndex = harness.writes.indexOf("\x1b[>4;2m");
			const queryIndex = harness.writes.indexOf("\x1b[>7u\x1b[?u\x1b[c");

			assert.notStrictEqual(modifyOtherKeysIndex, -1);
			assert.notStrictEqual(queryIndex, -1);
			assert.ok(modifyOtherKeysIndex < queryIndex);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;0m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("skips enhanced keyboard protocols when disabled while preserving input delivery", () => {
		const harness = setupNegotiation({ PI_TUI_KEYBOARD_PROTOCOL: "0", TMUX: "/tmp/tmux-501/default,123,0" });
		try {
			assert.equal(keyboardEnhancementEnabled(), false);
			assert.equal(harness.writes.includes("\x1b[>7u\x1b[?u\x1b[c"), false);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);

			harness.send("한");

			assert.equal(harness.getInput(), "한");

			harness.cleanup();
			assert.equal(harness.writes.includes("\x1b[<u"), false);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);
		} finally {
			harness.cleanup();
		}
	});
});

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});
