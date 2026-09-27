import { afterEach, expect, test, vi } from "vitest";
import { ProcessTerminal } from "../../../tui/src/terminal.ts";
import { copyToClipboard } from "../../src/utils/clipboard.ts";

vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	platform: () => "linux",
}));
vi.mock("../../src/utils/clipboard-command.ts", () => ({
	runClipboardCommand: () => {
		throw new Error("This test must never call a host clipboard command");
	},
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

test("the real clipboard helper reaches the terminal while external stdout is guarded", async () => {
	for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION", "TMUX", "TMUX_PANE", "PI_TUI_WRITE_LOG"])
		vi.stubEnv(name, undefined);
	vi.stubEnv("PI_TUI_KEYBOARD_PROTOCOL", "0");
	const writes: string[] = [];
	const hidden: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		writes.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	if (typeof process.stdin.setRawMode === "function")
		vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
	const terminal = new ProcessTerminal({ onExternalStdoutWrite: (text) => hidden.push(text) });
	try {
		terminal.start(
			() => {},
			() => {},
		);
		writes.length = 0;
		const text = "café é 👩🏽‍💻 漢字\nsecond line";
		await copyToClipboard(text);
		process.stdout.write("unrelated diagnostic\n");
		expect([...writes]).toEqual([`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`]);
		expect(hidden).toEqual(["unrelated diagnostic\n"]);
	} finally {
		terminal.stop();
	}
});
