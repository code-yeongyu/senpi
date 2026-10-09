import type * as OsModule from "node:os";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard } from "../../src/utils/clipboard.ts";

// Guards the interactive clipboard path: while a started ProcessTerminal hides external stdout,
// copyToClipboard's OSC 52 must still reach the terminal instead of the hidden-stdout handler.

const mocks = vi.hoisted(() => ({
	command:
		vi.fn<
			(
				command: string,
				args: readonly string[],
				options?: { input?: string; timeoutMs?: number },
			) => Promise<Buffer | undefined>
		>(),
	platform: vi.fn<() => NodeJS.Platform>(),
}));
vi.mock("../../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
vi.mock("node:os", async () => ({
	...(await vi.importActual<typeof OsModule>("node:os")),
	platform: mocks.platform,
}));

let terminal: ProcessTerminal;
let written: string[];
let hidden: string[];
let restore: () => void;

beforeEach(() => {
	const previousWrite = process.stdout.write;
	const previousStdinOn = process.stdin.on;
	const previousResume = process.stdin.resume;
	const previousPause = process.stdin.pause;
	written = [];
	hidden = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stdin.on = ((_event: string | symbol, _listener: (...args: unknown[]) => void) =>
		process.stdin) as typeof process.stdin.on;
	process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
	process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
	restore = () => {
		process.stdout.write = previousWrite;
		process.stdin.on = previousStdinOn;
		process.stdin.resume = previousResume;
		process.stdin.pause = previousPause;
	};
	for (const name of [
		"TMUX",
		"TMUX_PANE",
		"PI_TUI_WRITE_LOG",
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"TERMUX_VERSION",
		"WT_SESSION",
		"WSL_DISTRO_NAME",
		"WSLENV",
		"SSH_CLIENT",
		"MOSH_CONNECTION",
	])
		vi.stubEnv(name, "");
	vi.stubEnv("PI_TUI_KEYBOARD_PROTOCOL", "0");
	vi.stubEnv("SSH_CONNECTION", "client server");
	mocks.platform.mockReturnValue("linux");
	mocks.command.mockResolvedValue(undefined);
	terminal = new ProcessTerminal({ onExternalStdoutWrite: (text) => hidden.push(text) });
	terminal.start(
		() => {},
		() => {},
	);
	written.length = 0;
});

afterEach(() => {
	try {
		terminal.stop();
	} finally {
		restore();
		vi.unstubAllEnvs();
		vi.resetAllMocks();
	}
});

describe("copyToClipboard while the interactive terminal guards stdout", () => {
	test.each([
		{ name: "raw OSC 52 outside tmux", tmux: false, expected: "\x1b]52;c;aGVsbG8=\x07" },
		{
			name: "DCS-wrapped OSC 52 inside tmux with passthrough",
			tmux: true,
			expected: "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\",
		},
	])("delivers $name to the terminal, not the hidden-stdout handler", async ({ tmux, expected }) => {
		if (tmux) {
			vi.stubEnv("TMUX", "/tmp/tmux-1000/default,1,0");
			mocks.command.mockImplementation(async (name) => (name === "tmux" ? Buffer.from("on\n") : undefined));
		}

		await copyToClipboard("hello");

		expect(written).toContain(expected);
		expect(hidden.join("")).not.toContain("]52;c;");

		process.stdout.write("stray\n");
		expect(hidden).toContain("stray\n");
		expect(written).not.toContain("stray\n");
	});
});
