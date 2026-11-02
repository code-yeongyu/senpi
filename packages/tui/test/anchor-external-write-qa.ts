import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import xterm from "@xterm/headless";
import { createBunTerminalSession } from "../../pty/src/session-bun.ts";

const emulator = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
const signals = new EventEmitter();
let received = "";
const child = createBunTerminalSession(
	{
		command: "bun",
		args: [new URL("./anchor-external-write-qa-child.ts", import.meta.url).pathname],
		cols: 80,
		rows: 24,
		env: {
			...process.env,
			TERM: "xterm-256color",
			PI_TUI_KEYBOARD_PROTOCOL: "0",
			TMUX: undefined,
			TMUX_PANE: undefined,
			TERMUX_VERSION: undefined,
		},
	},
	(chunk) => {
		const text = Buffer.from(chunk).toString();
		received += text;
		for (const match of text.matchAll(/QA_(?:STATE|CPR)_([^\x07]*)/g)) console.log(match[0]);
		emulator.write(text, () => {
			for (const marker of ["QA_READY", "QA_AFTER_STDERR", "QA_RESULT_0", "QA_RESULT_1"]) {
				if (received.includes(marker)) {
					received = received.replace(marker, "");
					signals.emit(marker);
				}
			}
		});
	},
);
emulator.onData((data) => child.write(data));
function wait(marker: string) {
	return once(signals, marker, { signal: AbortSignal.timeout(10000) });
}
try {
	await wait("QA_READY");
	const after = wait("QA_AFTER_STDERR");
	child.write("e");
	await after;
	const grid = Array.from(
		{ length: 24 },
		(_, row) => emulator.buffer.active.getLine(emulator.buffer.active.viewportY + row)?.translateToString(true) ?? "",
	);
	console.log(
		JSON.stringify({
			surface: "real Bun PTY with headless terminal",
			optionRows: grid.flatMap((line, row) => (line.includes("OPTION") ? [row + 1] : [])),
			clickedRow: 20,
			clickedCell: grid[19],
			cursorRow: emulator.buffer.active.cursorY + 1,
			grid,
		}),
	);
	const result = Promise.race([wait("QA_RESULT_0").then(() => 0), wait("QA_RESULT_1").then(() => 1)]);
	child.write("\x1b[<0;5;20M\x1b[<0;5;20ms");
	const count = await result;
	console.log(`click count on non-option row: ${count}`);
	assert.equal(count, 0, "a non-option screen row must not activate the option after stderr moves the cursor");
	assert.equal(grid[23].trimEnd(), "OPTION");
	const answered = wait("QA_RESULT_1");
	child.write("\x1b[<0;5;24M\x1b[<0;5;24ms");
	await answered;
	console.log("PASS: ignored non-option row; fresh committed option click activated exactly once (2/2)");
} finally {
	child.write("q");
	child.kill();
	assert.ok(child.waitExit);
	await child.waitExit();
	emulator.dispose();
	console.log("QA child exited; emulator disposed");
}
