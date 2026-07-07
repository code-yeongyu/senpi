/**
 * PR-B2 QA — native-PTY drive of the REAL compiled terminal tool factories.
 *
 * Unlike the vitest suite (which forces the pipe fallback) this drives the tools
 * against the NATIVE pi-pty backend with real timing, running the plan's canonical
 * scenarios (bg+wait_for, python REPL steer -> 42, full-screen resize + view:screen,
 * kill_bash + OS orphan poll, foreground timeout kill, mode-aware background latency).
 *
 * Run from repo root:  node .omo/evidence/persistent-terminal-b2/native-tool-drive.mjs
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/packages/coding-agent/`);
const base = "./dist/core/extensions/builtin/terminal";
const { TerminalManager } = require(`${base}/manager.js`);
const { createPtyBashTool } = require(`${base}/tools/bash.js`);
const { createBashOutputTool } = require(`${base}/tools/bash-output.js`);
const { createBashInputTool } = require(`${base}/tools/bash-input.js`);
const { createBashResizeTool } = require(`${base}/tools/bash-resize.js`);
const { createKillBashTool } = require(`${base}/tools/kill-bash.js`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => r.content.find((b) => b.type === "text")?.text ?? "";
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) {
		pass++;
		console.log(`[PASS] ${name}`);
	} else {
		fail++;
		console.log(`[FAIL] ${name} ${extra}`);
	}
};

const manager = new TerminalManager({});
const ctx = {
	manager,
	cwd: process.cwd(),
	defaultCols: 120,
	defaultRows: 40,
	getEnv: () => process.env,
};
const bash = createPtyBashTool(ctx);
const output = createBashOutputTool(ctx);
const input = createBashInputTool(ctx);
const resize = createBashResizeTool(ctx);
const kill = createKillBashTool(ctx);

function idOf(result) {
	return /ID: (bash_\d+)/.exec(txt(result))?.[1];
}

async function main() {
	// 0 — confirm we are on the NATIVE backend (not pipe fallback).
	const fg = await bash.execute("c0", { command: "echo hello-native" }, undefined);
	ok("0: foreground echo returns output (native)", txt(fg).includes("hello-native"));
	const probe = await bash.execute("c0b", { command: "sleep 5", run_in_background: true }, undefined);
	const backendNote = txt(probe);
	ok("0: background NOT using pipe fallback (native PTY)", !backendNote.includes("pipe fallback"), backendNote);
	await kill.execute("c0kill", { all: true });

	// 1 — background + wait_for (canonical scenario a).
	const bg = await bash.execute("c1", { command: "sleep 0.4; echo READY_MARK", run_in_background: true }, undefined);
	const id1 = idOf(bg);
	ok("1: background returns a bash_id", !!id1);
	const waited = await output.execute("c1w", { bash_id: id1, wait_for: "READY_MARK", timeout: 5 });
	ok("1: bash_output wait_for resolves on READY_MARK", txt(waited).includes("READY_MARK"), txt(waited));

	// 2 — python REPL steering via bash_input (canonical scenario b).
	const repl = await bash.execute("c2", { command: "python3 -i -q", run_in_background: true }, undefined);
	const id2 = idOf(repl);
	await delay(600);
	await input.execute("c2i", { bash_id: id2, input: "print(6*7)" }); // submit defaults true
	await delay(600);
	const replOut = await output.execute("c2o", { bash_id: id2 });
	ok("2: python REPL bash_input print(6*7) -> 42", txt(replOut).includes("42"), txt(replOut));
	await kill.execute("c2k", { bash_id: id2 });

	// 3 — full-screen program + bash_resize + bash_output view:screen (canonical scenario c).
	// A bash loop that redraws its terminal width using $COLUMNS after a resize.
	const scr = await bash.execute(
		"c3",
		{ command: "while true; do printf '\\033[H\\033[2JW=%s\\n' \"$(tput cols)\"; sleep 0.2; done", run_in_background: true, cols: 80, rows: 24 },
		undefined,
	);
	const id3 = idOf(scr);
	await delay(500);
	const before = await output.execute("c3s1", { bash_id: id3, view: "screen" });
	ok("3: view:screen renders pre-resize width W=80", txt(before).includes("W=80"), txt(before));
	const rz = await resize.execute("c3r", { bash_id: id3, cols: 132, rows: 40 });
	ok("3: bash_resize reports 132x40", txt(rz).includes("132x40"), txt(rz));
	await delay(500);
	const after = await output.execute("c3s2", { bash_id: id3, view: "screen" });
	ok("3: view:screen reflows to W=132 after resize", txt(after).includes("W=132"), txt(after));
	await kill.execute("c3k", { bash_id: id3 });

	// 4 — kill_bash all + OS-level orphan poll (canonical scenario d).
	// Use a unique sleep DURATION as the marker: bash exec-replaces its image for a single
	// `-c` command, so the surviving argv is exactly ["sleep","<n>"] — pgrep -f "<n>" matches.
	const marker = `9${String(Date.now()).slice(-5)}`;
	const r4a = await bash.execute("c4a", { command: `sleep ${marker}`, run_in_background: true }, undefined);
	const r4b = await bash.execute("c4b", { command: `sleep ${marker}`, run_in_background: true }, undefined);
	console.log(`   [dbg] scenario4 ids: ${idOf(r4a)} ${idOf(r4b)}; a.err=${r4a.isError} b.err=${r4b.isError}`);
	await delay(800);
	const rawPg = execSync(`pgrep -fl "${marker}" || true`).toString().trim();
	console.log(`   [dbg] pgrep -fl "${marker}": ${JSON.stringify(rawPg)}`);
	const beforeKill = execSync(`pgrep -f "${marker}" || true`).toString().trim().split("\n").filter(Boolean).length;
	ok("4: live background sleep processes exist before kill", beforeKill >= 2, `count=${beforeKill}`);
	await kill.execute("c4k", { all: true });
	await delay(800);
	const afterKill = execSync(`pgrep -f "sleep ${marker}" || true`).toString().trim().split("\n").filter(Boolean).length;
	ok("4: kill_bash all leaves NO orphan processes", afterKill === 0, `count=${afterKill}`);

	// 5 — foreground timeout kill (canonical scenario, todo 18 failure path).
	const t0 = Date.now();
	const to = await bash.execute("c5", { command: "sleep 300", timeout: 2 }, undefined);
	const elapsed = (Date.now() - t0) / 1000;
	ok("5: foreground sleep 300 timeout:2 killed at ~2s", elapsed >= 1.5 && elapsed <= 6, `elapsed=${elapsed}s`);
	ok("5: timeout message surfaced", /timed out after 2 seconds/i.test(txt(to)), txt(to));

	// 6 — mode-aware background: returns PROMPTLY even though the command runs long.
	const t1 = Date.now();
	const late = await bash.execute("c6", { command: "sleep 300", run_in_background: true }, undefined);
	const latency = Date.now() - t1;
	const id6 = idOf(late);
	ok("6: background return latency < 1s (not blocked on timeout)", latency < 1000, `latency=${latency}ms`);
	await delay(400);
	const stillAlive = await output.execute("c6o", { bash_id: id6 });
	ok("6: background session still running (not killed by injected timeout)", txt(stillAlive).includes("status: running"), txt(stillAlive));
	await kill.execute("c6k", { all: true });

	await manager.teardown();
	console.log(`\nnative-tool-drive: ${pass}/${pass + fail} passed`);
	process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
