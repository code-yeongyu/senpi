import assert from "node:assert";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import { describe as vitestDescribe, it as vitestIt } from "vitest";
import {
	__stdinErrorDispatcherInstalledForTests,
	__stdinErrorSubscriberCountForTests,
	ProcessTerminal,
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

/**
 * A vanished controlling terminal (launcher killed, tmux pane closed, SSH
 * dropped) fails the in-flight stdin read with EIO. Without an "error"
 * listener, process.stdin rethrows it as an uncaught exception that kills the
 * agent process. The stdin guard must swallow EIO (and only EIO) from the
 * moment the terminal starts until a short grace window after stop().
 */

function eioStringCode(): Error {
	return Object.assign(new Error("EIO: i/o error, read"), { code: "EIO", errno: -5, syscall: "read" });
}

function eioNumericErrno(): Error {
	return Object.assign(new Error("read failed with errno: 5"), { errno: 5 });
}

function ebadf(): Error {
	return Object.assign(new Error("EBADF: bad file descriptor, read"), { code: "EBADF" });
}

interface StartedTerminal {
	terminal: ProcessTerminal;
	cleanup: () => void;
}

function startTerminal(): StartedTerminal {
	const previousKeyboardProtocol = process.env.PI_TUI_KEYBOARD_PROTOCOL;
	process.env.PI_TUI_KEYBOARD_PROTOCOL = "0";
	const terminal = new ProcessTerminal();
	terminal.start(
		() => {},
		() => {},
	);
	// Keep restore sequences out of the test transcript.
	Reflect.set(terminal, "rawStdoutWrite", (_data: string) => {});
	return {
		terminal,
		cleanup(): void {
			terminal.stop();
			if (previousKeyboardProtocol === undefined) {
				delete process.env.PI_TUI_KEYBOARD_PROTOCOL;
			} else {
				process.env.PI_TUI_KEYBOARD_PROTOCOL = previousKeyboardProtocol;
			}
		},
	};
}

describe("ProcessTerminal stdin detach", () => {
	it("swallows a stdin EIO reported with Node's string code while running", () => {
		// Given
		const started = startTerminal();
		try {
			// When / Then: an unlistened "error" event would rethrow from emit().
			assert.equal(__stdinErrorDispatcherInstalledForTests(), true);
			assert.equal(__stdinErrorSubscriberCountForTests(), 1);
			assert.doesNotThrow(() => process.stdin.emit("error", eioStringCode()));
		} finally {
			started.cleanup();
		}
	});

	it("swallows a stdin EIO reported with Bun's numeric errno", () => {
		// Given
		const started = startTerminal();
		try {
			// When / Then
			assert.doesNotThrow(() => process.stdin.emit("error", eioNumericErrno()));
		} finally {
			started.cleanup();
		}
	});

	it("keeps the EventEmitter contract for non-EIO stdin errors", () => {
		// Given
		const started = startTerminal();
		const failure = ebadf();
		try {
			// When / Then: EBADF is not a terminal detach and must keep propagating.
			assert.throws(
				() => process.stdin.emit("error", failure),
				(error: unknown) => error === failure,
			);
		} finally {
			started.cleanup();
		}
	});

	it("keeps swallowing a late EIO during the stop grace window", () => {
		// Given
		const started = startTerminal();
		// When: stop, then a late PTY failure arrives inside the grace window.
		started.cleanup();
		// Then
		assert.doesNotThrow(() => process.stdin.emit("error", eioStringCode()));
	});

	it("removes the guard once the stop grace window expires", async () => {
		// Given
		const started = startTerminal();
		started.cleanup();
		// When: the grace window (250ms) has fully elapsed.
		await new Promise((resolve) => setTimeout(resolve, 400));
		// Then: no leaked listener remains, so EIO rethrows like any unlistened error.
		assert.equal(__stdinErrorSubscriberCountForTests(), 0);
		assert.equal(__stdinErrorDispatcherInstalledForTests(), false);
		assert.throws(() => process.stdin.emit("error", eioStringCode()));
	});
});
