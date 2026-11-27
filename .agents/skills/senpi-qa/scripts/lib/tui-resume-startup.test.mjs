import assert from "node:assert/strict";
import test from "node:test";
import { COLS, FINAL_MARKER, FIRST_MARKER } from "./tui-resume-args.mjs";
import { driveResume } from "./tui-resume-pty.mjs";

const BORDER_IDLE = 244;
const BORDER_BASH = 214;

/**
 * A stand-in for the interactive TUI (senpi#5291): the header shows at once, but submits are refused until startup
 * finishes after `readyAfterWrites` input writes, like interactive-mode.ts handleStartupSubmit. Only a finished startup
 * recolors the composer border for `!` (bash mode). A refused submit ends the fake at once, so a driver that submits
 * too early fails on that instead of on a selector timeout.
 */
function fakeResumeTui({ readyAfterWrites }) {
	const stream = { raw: "", exit: null, listeners: new Set() };
	const state = { writes: 0, text: "", mode: "composer", status: "", refusedSubmits: 0, submits: [] };
	const notify = () => {
		for (const listener of [...stream.listeners]) listener();
	};
	const render = () => {
		const ready = state.writes >= readyAfterWrites;
		const lines = ["senpi v0.0.0-test", state.status];
		if (state.mode === "selector") lines.push("Resume Session", `> ${FIRST_MARKER}`);
		if (state.mode === "resumed") lines.push(FIRST_MARKER, FINAL_MARKER);
		const color = ready && state.text.startsWith("!") ? BORDER_BASH : BORDER_IDLE;
		lines.push(`\x1b[38;5;${color}m${"\u2500".repeat(COLS)}\x1b[39m`, `\u276f ${state.text}`);
		stream.raw += `\x1b[?2026h\x1b[H\x1b[2J${lines.join("\r\n")}\x1b[?2026l`;
		notify();
	};
	const submit = () => {
		if (state.mode === "selector") {
			state.mode = "resumed";
			return;
		}
		state.submits.push(state.text);
		if (state.writes < readyAfterWrites) {
			state.refusedSubmits += 1;
			state.status = "Startup is still in progress";
			stream.exit = { exitCode: 1, signal: null };
			return;
		}
		if (state.text === "/resume") state.mode = "selector";
		state.text = "";
	};
	const term = {
		write(data) {
			state.writes += 1;
			setImmediate(() => {
				if (stream.exit) return;
				for (const key of data) {
					if (key === "\r") submit();
					else if (key === "\x7f") state.text = state.text.slice(0, -1);
					else state.text += key;
					if (stream.exit) break;
				}
				if (stream.exit) notify();
				else render();
			});
		},
	};
	render();
	return { term, stream, state };
}

test("driveResume submits /resume only after startup accepts submits", async () => {
	const fake = fakeResumeTui({ readyAfterWrites: 3 });
	const actions = [];

	const timing = await driveResume(fake.term, fake.stream, { messages: 2, actions });

	assert.equal(fake.state.refusedSubmits, 0);
	assert.deepEqual(fake.state.submits, ["/resume"]);
	assert.ok(timing.finalMarkerIndex > timing.firstMarkerIndex);
	assert.equal(actions.find((action) => action.type === "ready")?.probes, 2);
});
