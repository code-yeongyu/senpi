import assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { mock, describe as nodeDescribe, it as nodeIt } from "node:test";
import { vi, describe as vitestDescribe, it as vitestIt } from "vitest";
import { setKittyProtocolActive } from "../src/keys.ts";
import {
	keyboardEnhancementEnabled,
	normalizeAppleTerminalInput,
	normalizeNativeShiftEnterInput,
	normalizeWarpWslShiftEnterInput,
	ProcessTerminal,
	resolveEscapeTimeoutMs,
} from "../src/terminal.ts";

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

type TerminalStopHarness = {
	terminal: ProcessTerminal;
	cleanup(): void;
};

function setupTerminalStopHarness(wasRaw: boolean, restoreRawMode: (mode: boolean) => void): TerminalStopHarness {
	const terminal = new ProcessTerminal();
	const previousPause = process.stdin.pause;
	const previousSetRawMode = process.stdin.setRawMode;

	Reflect.set(terminal, "wasRaw", wasRaw);
	Reflect.set(terminal, "rawStdoutWrite", (_data: string) => {});
	Reflect.set(process.stdin, "pause", () => process.stdin);
	Reflect.set(process.stdin, "setRawMode", (mode: boolean) => {
		restoreRawMode(mode);
		return process.stdin;
	});

	return {
		terminal,
		cleanup(): void {
			Reflect.set(process.stdin, "pause", previousPause);
			Reflect.set(process.stdin, "setRawMode", previousSetRawMode);
		},
	};
}

describe("resolveEscapeTimeoutMs", () => {
	it("uses PI_TUI_ESC_TIMEOUT when configured", () => {
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "80" }), 80);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "80", SSH_TTY: "/dev/pts/1" }), 80);
	});

	it("ignores invalid PI_TUI_ESC_TIMEOUT values", () => {
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "abc" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "0" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "-5" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "" }), 10);
	});

	it("defaults to 100ms over SSH", () => {
		assert.equal(resolveEscapeTimeoutMs({ SSH_CONNECTION: "10.0.0.1 22" }), 100);
		assert.equal(resolveEscapeTimeoutMs({ SSH_TTY: "/dev/pts/1" }), 100);
	});

	it("defaults to 10ms otherwise", () => {
		assert.equal(resolveEscapeTimeoutMs({}), 10);
	});
});

describe("normalizeNativeShiftEnterInput", () => {
	it("rewrites Return to CSI-u Shift+Enter when native Shift detection is enabled and Shift is pressed", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Return unchanged when native Shift detection is disabled", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", false, true), "\r");
	});

	it("leaves Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", true, false), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeNativeShiftEnterInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeNativeShiftEnterInput("a", true, true), "a");
	});
});

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

describe("normalizeWarpWslShiftEnterInput", () => {
	it("does not check the WSL socket when Warp is not detected", () => {
		let socketChecks = 0;
		assert.equal(
			normalizeWarpWslShiftEnterInput("\n", { WSL_INTEROP: "/run/WSL/321_interop" }, "linux", () => {
				socketChecks += 1;
				return true;
			}),
			"\n",
		);
		assert.equal(socketChecks, 0);
	});

	it("rejects regular files, directories, and symlinks to non-sockets", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tui-wsl-"));
		const regularFile = path.join(tempDir, "regular-file");
		const directory = path.join(tempDir, "directory");
		const symlinkToFile = path.join(tempDir, "symlink-to-file");
		fs.writeFileSync(regularFile, "not a socket");
		fs.mkdirSync(directory);
		fs.symlinkSync(regularFile, symlinkToFile);
		const env = { WARP_SESSION_ID: "session", WSL_INTEROP: "/run/WSL/123_interop" };
		try {
			for (const entry of [regularFile, directory, symlinkToFile]) {
				assert.equal(
					normalizeWarpWslShiftEnterInput("\n", env, "linux", () => fs.statSync(entry).isSocket()),
					"\n",
					entry,
				);
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts a symlink to a real socket", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tui-wsl-"));
		const socketPath = path.join(tempDir, "interop.sock");
		const socketAlias = path.join(tempDir, "interop-alias");
		const server = net.createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			fs.symlinkSync(socketPath, socketAlias);
			assert.equal(
				normalizeWarpWslShiftEnterInput(
					"\n",
					{ WARP_SESSION_ID: "session", WSL_INTEROP: "/run/WSL/123_interop" },
					"linux",
					() => fs.statSync(socketAlias).isSocket(),
				),
				"\x1b[13;2u",
			);
		} finally {
			server.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rewrites Warp-on-WSL LF as explicit Shift+Enter", () => {
		assert.equal(
			normalizeWarpWslShiftEnterInput(
				"\n",
				{
					TERM_PROGRAM: "WarpTerminal",
					WARP_SESSION_ID: "session",
					WSL_DISTRO_NAME: "Ubuntu",
					WSL_INTEROP: "/run/WSL/1_interop",
				},
				"linux",
				() => true,
			),
			"\x1b[13;2u",
		);
		assert.equal(
			normalizeWarpWslShiftEnterInput(
				"\n",
				{
					WARP_SESSION_ID: "session",
					WSL_INTEROP: "/run/WSL/1_interop",
				},
				"linux",
				() => true,
			),
			"\x1b[13;2u",
		);
	});

	it("rejects spoofed Warp and WSL markers", () => {
		const validWsl = { WARP_SESSION_ID: "session", WSL_INTEROP: "/run/WSL/123_interop" };
		assert.equal(
			normalizeWarpWslShiftEnterInput("\n", { ...validWsl, WARP_SESSION_ID: "" }, "linux", () => true),
			"\n",
		);
		assert.equal(
			normalizeWarpWslShiftEnterInput(
				"\n",
				{ TERM_PROGRAM: "WarpTerminal", ...validWsl, WARP_SESSION_ID: undefined },
				"linux",
				() => true,
			),
			"\n",
		);
		for (const interop of [
			"/run/WSL/not-a-real-socket",
			"/run/WSL/123",
			"/run/WSL/123_interop-extra",
			"/tmp/123_interop",
		]) {
			assert.equal(
				normalizeWarpWslShiftEnterInput("\n", { ...validWsl, WSL_INTEROP: interop }, "linux", () => true),
				"\n",
				interop,
			);
		}
		assert.equal(
			normalizeWarpWslShiftEnterInput("\n", validWsl, "linux", () => false),
			"\n",
		);
	});

	it("does not treat empty or non-Linux WSL markers as a target session", () => {
		assert.equal(
			normalizeWarpWslShiftEnterInput(
				"\n",
				{
					TERM_PROGRAM: "WarpTerminal",
					WSL_DISTRO_NAME: "",
				},
				"linux",
			),
			"\n",
		);
		assert.equal(
			normalizeWarpWslShiftEnterInput(
				"\n",
				{
					TERM_PROGRAM: "WarpTerminal",
					WSL_INTEROP: "/run/WSL/1_interop",
				},
				"darwin",
				() => true,
			),
			"\n",
		);
		assert.equal(
			normalizeWarpWslShiftEnterInput(
				"\n",
				{
					TERM_PROGRAM: "WarpTerminal",
					WSL_INTEROP: "spoofed",
				},
				"linux",
			),
			"\n",
		);
	});

	it("leaves other terminals, remote or multiplexed sessions, and input unchanged", () => {
		assert.equal(normalizeWarpWslShiftEnterInput("\n", { WSL_DISTRO_NAME: "Ubuntu" }, "linux"), "\n");
		assert.equal(normalizeWarpWslShiftEnterInput("\n", { TERM_PROGRAM: "WarpTerminal" }, "linux"), "\n");
		assert.equal(
			normalizeWarpWslShiftEnterInput("\r", {
				TERM_PROGRAM: "WarpTerminal",
				WSL_DISTRO_NAME: "Ubuntu",
			}),
			"\r",
		);
		for (const key of ["TMUX", "TMUX_PANE", "STY", "ZELLIJ"] as const) {
			assert.equal(
				normalizeWarpWslShiftEnterInput("\n", {
					TERM_PROGRAM: "WarpTerminal",
					WSL_DISTRO_NAME: "Ubuntu",
					[key]: "active",
				}),
				"\n",
				key,
			);
		}
		for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const) {
			assert.equal(
				normalizeWarpWslShiftEnterInput("\n", {
					TERM_PROGRAM: "WarpTerminal",
					WSL_DISTRO_NAME: "Ubuntu",
					[key]: "active",
				}),
				"\n",
				key,
			);
		}
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

	it("forwards Warp-on-WSL LF unchanged for non-editor consumers", () => {
		const harness = setupNegotiation({
			TERM_PROGRAM: "WarpTerminal",
			WARP_SESSION_ID: undefined,
			WARP_TERMINAL_SESSION_UUID: undefined,
			WSL_DISTRO_NAME: "Ubuntu",
			WSL_INTEROP: undefined,
		});
		try {
			harness.send("\n");
			assert.equal(harness.getInput(), "\n");

			harness.send("\r");
			assert.equal(harness.getInput(), "\r");
		} finally {
			harness.cleanup();
		}
	});

	it("reassembles split multibyte Buffer chunks before forwarding input", () => {
		const harness = setupNegotiation();
		try {
			harness.send(Buffer.from([0xe4, 0xb8]));
			assert.equal(harness.getInput(), undefined);

			harness.send(Buffer.from([0xad]));

			assert.equal(harness.getInput(), "中");
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
			advanceTimersByTime(50); // StdinBuffer sequence timeout, not the lone-ESC timeout

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

			harness.send("中");

			assert.equal(harness.getInput(), "中");

			harness.cleanup();
			assert.equal(harness.writes.includes("\x1b[<u"), false);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);
		} finally {
			harness.cleanup();
		}
	});
});

describe("ProcessTerminal stop", () => {
	it("restores the previous raw mode during stop", () => {
		// Given
		const restoredModes: boolean[] = [];
		const harness = setupTerminalStopHarness(true, (mode) => {
			restoredModes.push(mode);
		});

		try {
			// When
			harness.terminal.stop();

			// Then
			assert.deepEqual(restoredModes, [true]);
		} finally {
			harness.cleanup();
		}
	});

	it("does not throw when raw-mode restoration fails during stop", () => {
		// Given
		const eio = Object.assign(new Error("setRawMode failed with errno: 5"), { errno: 5 });
		const harness = setupTerminalStopHarness(false, () => {
			throw eio;
		});

		try {
			// When / Then
			assert.doesNotThrow(() => harness.terminal.stop());
		} finally {
			harness.cleanup();
		}
	});

	it("does not throw when Bun reports the dead terminal only in the message", () => {
		// Given
		const bunShimEio = new Error("setRawMode failed with errno: 5");
		const harness = setupTerminalStopHarness(false, () => {
			throw bunShimEio;
		});

		try {
			// When / Then
			assert.doesNotThrow(() => harness.terminal.stop());
		} finally {
			harness.cleanup();
		}
	});

	it("does not throw when the message carries the EPIPE errno", () => {
		// Given
		const bunShimEpipe = new Error("setRawMode failed with errno: 32");
		const harness = setupTerminalStopHarness(false, () => {
			throw bunShimEpipe;
		});

		try {
			// When / Then
			assert.doesNotThrow(() => harness.terminal.stop());
		} finally {
			harness.cleanup();
		}
	});

	it("rethrows raw-mode failures whose message carries no dead-terminal errno", () => {
		// Given
		const unrelated = new Error("boom");
		const harness = setupTerminalStopHarness(false, () => {
			throw unrelated;
		});

		try {
			// When / Then
			assert.throws(
				() => harness.terminal.stop(),
				(error: unknown) => error === unrelated,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("rethrows raw-mode failures carrying a non-dead errno in the message", () => {
		// Given
		const unrelated = new Error("setRawMode failed with errno: 22");
		const harness = setupTerminalStopHarness(false, () => {
			throw unrelated;
		});

		try {
			// When / Then
			assert.throws(
				() => harness.terminal.stop(),
				(error: unknown) => error === unrelated,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("does not throw when Node reports the dead terminal by error code", () => {
		// Given
		const eio = Object.assign(new Error("setRawMode failed"), { code: "EIO" });
		const harness = setupTerminalStopHarness(false, () => {
			throw eio;
		});

		try {
			// When / Then
			assert.doesNotThrow(() => harness.terminal.stop());
		} finally {
			harness.cleanup();
		}
	});

	it("rethrows unexpected raw-mode restoration failures", () => {
		// Given
		const invalidArgument = Object.assign(new Error("unexpected setRawMode failure"), { code: "EINVAL" });
		const harness = setupTerminalStopHarness(false, () => {
			throw invalidArgument;
		});

		try {
			// When / Then
			assert.throws(
				() => harness.terminal.stop(),
				(error: unknown) => error === invalidArgument,
			);
		} finally {
			harness.cleanup();
		}
	});
});

describe("ProcessTerminal progress", () => {
	it("writes a valid OSC 9;4 clear sequence", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const previousWrite = process.stdout.write;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;

		try {
			terminal.setProgress(false);
			assert.deepEqual(writes, ["\x1b]9;4;0\x07"]);
		} finally {
			process.stdout.write = previousWrite;
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

describe("ProcessTerminal setTitle", () => {
	function captureSetTitle(title: string): string[] {
		const writes: string[] = [];
		const previousWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			new ProcessTerminal().setTitle(title);
		} finally {
			process.stdout.write = previousWrite;
		}
		return writes;
	}

	it("strips control characters so titles cannot escape the OSC sequence", () => {
		const writes = captureSetTitle("evil\x07\x1b[2Jrest\ntitle\x9c!");

		assert.deepEqual(writes, ["\x1b]0;evil[2Jresttitle!\x07"]);
	});

	it("passes plain titles through unchanged", () => {
		const writes = captureSetTitle("pi - my-project");

		assert.deepEqual(writes, ["\x1b]0;pi - my-project\x07"]);
	});
});
