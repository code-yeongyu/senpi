import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { ProcessTerminal, parseCursorPositionResponse } from "../src/terminal.ts";

function scriptedTerminal(
	t: TestContext,
	response?: string,
	negotiate = false,
	options: { tmuxExecFile?: (file: string, args: readonly string[]) => string } = {},
) {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const old = process.env.PI_TUI_KEYBOARD_PROTOCOL;
	process.env.PI_TUI_KEYBOARD_PROTOCOL = negotiate ? "1" : "0";
	const writes: string[] = [];
	const input: string[] = [];
	t.mock.method(process.stdin, "resume", () => process.stdin);
	t.mock.method(process.stdin, "pause", () => process.stdin);
	t.mock.method(process, "kill", () => true);
	t.mock.method(process.stdout, "write", ((chunk: string | Uint8Array) => {
		const text = String(chunk);
		writes.push(text);
		if (text === "\x1b[?6n" && response) process.stdin.emit("data", response);
		return true;
	}) as typeof process.stdout.write);
	const terminal = new ProcessTerminal(options);
	terminal.start(
		(data) => input.push(data),
		() => {},
	);
	t.after(() => {
		terminal.stop();
		if (old === undefined) delete process.env.PI_TUI_KEYBOARD_PROTOCOL;
		else process.env.PI_TUI_KEYBOARD_PROTOCOL = old;
	});
	return { terminal, writes, input, send: (data: string) => process.stdin.emit("data", data) };
}
function tmuxPane(t: TestContext) {
	const old = process.env.TMUX_PANE;
	process.env.TMUX_PANE = "%42";
	t.after(() => {
		if (old === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = old;
	});
}

it("uses two matching tmux readings separated by at least 10ms (#1645)", async (t) => {
	tmuxPane(t);
	const calls: number[] = [];
	const { terminal, writes } = scriptedTerminal(t, undefined, false, {
		tmuxExecFile: (file, args) => {
			assert.equal(file, "tmux");
			assert.deepEqual(args, ["display-message", "-p", "-t", "%42", "#{cursor_y} #{cursor_x}"]);
			calls.push(Date.now());
			return "11 4\n";
		},
	});
	const query = terminal.queryCursorPosition();
	assert.equal(terminal.queryCursorPosition(), query);
	assert.equal(calls.length, 1);
	t.mock.timers.tick(9);
	assert.equal(calls.length, 1);
	t.mock.timers.tick(1);
	assert.deepEqual(await query, { row: 12, column: 5 });
	assert.deepEqual(calls, [0, 10]);
	assert.ok(writes.includes("\x1b[?6n"));
});

for (const output of ["12 4", "bad", "-1 4", "1.5 4", "1 2 3", "9007199254740991 0"]) {
	it(`fails closed for mismatched or malformed tmux output ${output}`, async (t) => {
		tmuxPane(t);
		let calls = 0;
		const { terminal } = scriptedTerminal(t, undefined, false, {
			tmuxExecFile: () => (++calls === 1 ? "11 4" : output),
		});
		const query = terminal.queryCursorPosition();
		t.mock.timers.tick(10);
		// Also bounds the pre-implementation private-only query for assertion-based RED.
		t.mock.timers.tick(740);
		assert.equal(await query, undefined);
		assert.equal(calls, 2);
	});
}

it("fails closed on tmux exec error without accepting private replies", async (t) => {
	tmuxPane(t);
	let calls = 0;
	const { terminal, send } = scriptedTerminal(t, undefined, false, {
		tmuxExecFile: () => {
			calls++;
			throw new Error("exec failed");
		},
	});
	const query = terminal.queryCursorPosition();
	send("\x1b[?12;5R");
	t.mock.timers.tick(750);
	assert.equal(await query, undefined);
	assert.equal(calls, 1);
});

it("preserves the total timeout and restart-only recovery for tmux", async (t) => {
	tmuxPane(t);
	let calls = 0;
	const { terminal } = scriptedTerminal(t, undefined, false, {
		tmuxExecFile: () => {
			calls++;
			t.mock.timers.tick(750);
			return "11 4";
		},
	});
	const query = terminal.queryCursorPosition();
	t.mock.timers.tick(750);
	assert.equal(await query, undefined);
	assert.equal(await terminal.queryCursorPosition(), undefined);
	assert.equal(calls, 1);
});

it("never executes tmux outside a pane and retains private query bytes", async (t) => {
	let calls = 0;
	const { terminal, writes } = scriptedTerminal(t, "\x1b[?12;5R", false, {
		tmuxExecFile: () => {
			calls++;
			return "11 4";
		},
	});
	assert.equal(process.env.TMUX_PANE, undefined);
	assert.deepEqual(await terminal.queryCursorPosition(), { row: 12, column: 5 });
	assert.equal(calls, 0);
	assert.equal(writes.filter((w) => w === "\x1b[?6n").length, 1);
});

it("rejects bare CPR-shaped function keys (#1645)", () => {
	assert.equal(parseCursorPositionResponse("\x1b[1;2R"), undefined);
});
for (const [reply, expected] of [
	["\x1b[?12;1R", { row: 12, column: 1 }],
	["\x1b[?12;1;1R", { row: 12, column: 1, page: 1 }],
] as const) {
	it(`resolves synchronous private reply ${JSON.stringify(reply)}`, async (t) => {
		const { terminal, input, writes } = scriptedTerminal(t, reply);
		assert.deepEqual(await terminal.queryCursorPosition(), expected);
		assert.deepEqual(input, []);
		assert.equal(writes.filter((w) => w === "\x1b[?6n").length, 1);
	});
}
it("shares one pending query and preserves interleaved keyboard input", async (t) => {
	const { terminal, input, send } = scriptedTerminal(t);
	const first = terminal.queryCursorPosition();
	assert.equal(terminal.queryCursorPosition(), first);
	send("a");
	send("\x1b[?12;");
	send("1;1R");
	assert.deepEqual(await first, { row: 12, column: 1, page: 1 });
	assert.deepEqual(input, ["a"]);
	send("\x1b[?12;1R");
	assert.deepEqual(input, ["a"]);
});
it("forwards bare replies and times out instead of interpreting function keys", async (t) => {
	const { terminal, input, send } = scriptedTerminal(t);
	const query = terminal.queryCursorPosition();
	send("\x1b[12;1R");
	t.mock.timers.tick(750);
	assert.equal(await query, undefined);
	assert.deepEqual(input, ["\x1b[12;1R"]);
});
it("discards late private replies after bounded timeout", async (t) => {
	const { terminal, input, send } = scriptedTerminal(t);
	const query = terminal.queryCursorPosition();
	t.mock.timers.tick(750);
	assert.equal(await query, undefined);
	send("\x1b[?12;1R");
	assert.deepEqual(input, []);
});
it("does not leak a late fragmented private response tail", async (t) => {
	const { terminal, input, send } = scriptedTerminal(t);
	const query = terminal.queryCursorPosition();
	send("\x1b[?12;");
	t.mock.timers.tick(50);
	t.mock.timers.tick(150);
	t.mock.timers.tick(550);
	assert.equal(await query, undefined);
	send("1R");
	assert.deepEqual(input, []);
	send("a");
	assert.deepEqual(input, ["a"]);
});
it("issues CPR only after keyboard negotiation settles", async (t) => {
	const { terminal, writes, send } = scriptedTerminal(t, undefined, true);
	const query = terminal.queryCursorPosition();
	assert.equal(writes.includes("\x1b[?6n"), false);
	send("\x1b[?1u");
	assert.equal(writes.includes("\x1b[?6n"), true);
	send("\x1b[?12;1R");
	assert.deepEqual(await query, { row: 12, column: 1 });
});
