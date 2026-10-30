#!/usr/bin/env node
// senpi#3649: open /btw while a long eval runs and prove the panel stays one fixed region. The whole PTY byte
// stream is replayed into @xterm/headless with retained scrollback, so a panel that the renderer re-emits into
// the scrollback on each frame shows up as repeated panel rows; live/done frames are rendered to PNG via xterm.js.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	cliEntry,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	stripAnsi,
	tsxEntry,
	signalOwnedProcess,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { chromeExecutable, spawnTerminal, waitForCapture, waitForExit } from "./eval-live-terminal.mjs";

const API = "openai-completions";
const COLS = 100;
const ROWS = Number(process.env.SENPI_QA_ROWS ?? 24);
const FINAL_MARKER = "BTW-EVAL-DONE";
const QUESTION = "what is the sandbox for";
const BTW_END = "BTW-ANSWER-END";
const BTW_LINES = [...Array.from({ length: 16 }, (_, index) => `btw answer line ${index}`), BTW_END];
const EVAL_LINES = 40;
const COMMAND =
	"node .agents/skills/senpi-qa/scripts/scenarios/btw-during-eval-qa.mjs --self-test --evidence btw-during-eval";

const argv = process.argv.slice(2);
const evidenceIndex = argv.indexOf("--evidence");
const evidenceSlug = evidenceIndex >= 0 ? argv[evidenceIndex + 1] : undefined;
if (!argv.includes("--self-test")) throw new Error("pass --self-test");
if (!evidenceSlug) throw new Error("--evidence requires a slug");

function recordedChecks(title) {
	const rows = [];
	return {
		ok(name, pass, detail = "") {
			rows.push({ name, pass: Boolean(pass), detail });
			process.stdout.write(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}\n`);
		},
		finish() {
			const failed = rows.filter((row) => !row.pass).length;
			process.stdout.write(`\n${title}: ${rows.length - failed}/${rows.length} passed\n`);
			return { passed: failed === 0, rows };
		},
	};
}

async function replayBuffer(root, bytes) {
	const require = createRequire(join(root, "packages", "tui", "package.json"));
	const { Terminal } = require("@xterm/headless");
	const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 100_000, allowProposedApi: true });
	await new Promise((resolveWrite) => terminal.write(bytes, resolveWrite));
	const buffer = terminal.buffer.active;
	const rows = [];
	for (let row = 0; row < buffer.length; row++) rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
	terminal.dispose();
	return rows;
}

async function frameViolations(root, bytes, fromOffset, pinnedFrom) {
	const require = createRequire(join(root, "packages", "tui", "package.json"));
	const { Terminal } = require("@xterm/headless");
	const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 100_000, allowProposedApi: true });
	const write = (data) => new Promise((resolveWrite) => terminal.write(data, resolveWrite));
	const parts = bytes.split("\x1b[?2026h");
	let offset = 0;
	const violations = [];
	for (let index = 0; index < parts.length; index++) {
		const part = (index === 0 ? "" : "\x1b[?2026h") + parts[index];
		offset += part.length;
		await write(part);
		if (offset <= fromOffset) continue;
		const buffer = terminal.buffer.active;
		const rows = [];
		for (let row = 0; row < buffer.length; row++) rows.push(buffer.getLine(row)?.translateToString(true).trimEnd() ?? "");
		const viewport = rows.slice(buffer.viewportY, buffer.viewportY + ROWS);
		const panelStart = viewport.findIndex((row) => /btw answer line \d+$/u.test(row) || row.endsWith(BTW_END));
		const intruders = panelStart < 0 ? [] : viewport.slice(panelStart).filter((row) => row.includes("eval output line"));
		const repeated = [...BTW_LINES, `btw: ${QUESTION}`].filter((line) => rows.filter((row) => row.endsWith(line)).length > 1);
		const panelMissing = offset > pinnedFrom && !viewport.some((row) => row.endsWith(BTW_END));
		if (intruders.length > 0 || repeated.length > 0 || panelMissing) {
			violations.push({ frame: index, intruders: intruders.length, repeated, panelMissing });
		}
	}
	terminal.dispose();
	return violations;
}

// tsx runs the CLI in a child process that can outlive the PTY's own exit and write its debug log into the
// removed sandbox; the whole process group is ended and awaited before the sandbox is removed.
async function reapProcessGroup(term) {
	const pid = term.pid;
	const alive = () => {
		try {
			process.kill(-pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	if (alive()) {
		try {
			signalOwnedProcess({ pid: term.pid, spawned: term, group: true, signal: "SIGKILL" });
		} catch {}
	}
	const deadline = Date.now() + 5_000;
	// The tsx child is not this process's child, so no exit event exists for it; a 50 ms timer bounds the wait
	// without spinning the event loop.
	while (alive() && Date.now() < deadline) await new Promise((resolveTick) => setTimeout(resolveTick, 50));
	return !alive();
}

const countRows = (rows, needle) => rows.filter((row) => row.includes(needle)).length;
const countEvalRow = (rows, line) => rows.filter((row) => new RegExp(`eval output line ${line}$`, "u").test(row.trimEnd())).length;

async function main() {
	installCleanupHooks();
	const checks = recordedChecks("btw-during-eval-qa.mjs --self-test");
	const guard = guardRealAuth();
	const root = repoRoot();
	const evidence = evidenceDir(evidenceSlug);
	const box = makeSandbox("btw-during-eval");

	let server;
	let term;
	let raw = "";
	let liveRaw = "";
	let finalRaw = "";
	let settledAt = 0;
	let btwAt = 0;
	let catchUpReplay = false;
	let runError;
	const cleanup = { ptyExited: false, serverStopped: false, sandboxRemoved: false, authUnchanged: false };

	try {
		server = await startFakeModelServer({
			turns: [
				{
					toolCalls: [
						{
							name: "eval",
							args: {
								language: "js",
								summary: "Print progress lines slowly",
								code: [
									`for (let line = 0; line < ${EVAL_LINES}; line++) {`,
									"\tconsole.log(`eval output line ${line}`);",
									"\tawait new Promise((resolve) => setTimeout(resolve, 350));",
									"}",
								].join("\n"),
							},
						},
					],
				},
				{ text: BTW_LINES.join("\n"), chunks: 6, chunkDelayMs: 150 },
				{ text: FINAL_MARKER },
			],
		});
		writeMockModelsJson(box.agentDir, server, API);
		const preset = API_PRESETS[API];
		term = await spawnTerminal(
			process.execPath,
			[
				tsxEntry(root),
				"--tsconfig",
				join(root, "tsconfig.json"),
				cliEntry(root),
				"--no-context-files",
				"--no-skills",
				"--no-extensions",
				"--approve",
				"--provider",
				preset.provider,
				"--model",
				preset.modelId,
				"Run the btw probe.",
			],
			{
				name: "xterm-color",
				cols: COLS,
				rows: ROWS,
				cwd: box.cwd,
				env: hermeticEnv(box.env),
				pipePath: join(box.dir, "btw-during-eval-pty.ans"),
				sessionName: `senpi-qa-btw-eval-${process.pid}`,
			},
		);
		term.onData((data) => {
			raw += data;
		});
		await waitForCapture(term, () => raw, (text) => /eval js[^\n]* running/u.test(text), 120_000, "running eval");
		// ctrl+o expands tool output, so the running eval streams its rows above the live area.
		term.write("\x0f");
		await waitForCapture(term, () => raw, (text) => /eval output line \d/u.test(text), 60_000, "expanded eval output");
		btwAt = raw.length;
		term.write(`/btw ${QUESTION}\r`);
		await waitForCapture(term, () => raw, (text) => text.includes(BTW_END), 60_000, "btw answer end");
		settledAt = raw.length;
		// The live frame is taken while the eval keeps running under the settled panel, a few elapsed-time ticks later.
		await waitForCapture(
			term,
			() => raw,
			(text) => text.length > settledAt && /Running eval \((9|1[0-3])s/u.test(stripAnsi(raw.slice(settledAt))),
			60_000,
			"eval still running after the btw answer",
		);
		liveRaw = raw;
		// The final reply lands above the full-screen live area, held until input; a no-op edit triggers the catch-up.
		await waitForCapture(term, () => raw, () => (server?.requests.length ?? 0) >= 4, 120_000, "the request that follows the final reply");
		term.write(" ");
		term.write("\x7f");
		await waitForCapture(term, () => raw, (text) => text.includes(FINAL_MARKER), 120_000, "final model marker");
		// The next keypress after the turn replays the held scrollback once (#2836); the end state is checked after it.
		const replayFrom = raw.length;
		term.write(" ");
		// Only a turn that held stale rows replays; without one the key paints a normal frame.
		catchUpReplay = await waitForCapture(term, () => raw, () => raw.indexOf("\x1b[3J", replayFrom) >= 0, 8_000, "the catch-up scrollback replay")
			.then(() => true)
			.catch(() => false);
		const frameFrom = catchUpReplay ? raw.indexOf("\x1b[3J", replayFrom) : replayFrom;
		await waitForCapture(term, () => raw, () => raw.indexOf("\x1b[?2026l", frameFrom) >= 0, 10_000, "the frame after the key");
		finalRaw = raw;
	} catch (error) {
		runError = error;
	} finally {
		if (term) {
			const exited = waitForExit(term, 5_000);
			try {
				term.write("\x03\x03");
				term.kill();
			} catch {}
			cleanup.ptyExited = await exited;
			if (typeof term.pid === "number") cleanup.ptyExited &&= await reapProcessGroup(term);
		} else cleanup.ptyExited = true;
		if (server) {
			await server.stop().catch(() => {});
		}
		cleanup.serverStopped = true;
		box.cleanup();
		cleanup.sandboxRemoved = !existsSync(box.dir);
		try {
			cleanup.authUnchanged = guard.assertUnchanged();
		} catch {}
	}

	const chrome = chromeExecutable();
	const renderFrame = (name, bytes) => {
		const rawPath = join(evidence, `${name}.ans`);
		const gridPath = join(evidence, `${name}.grid.json`);
		const htmlPath = join(evidence, `${name}.html`);
		const screenshotPath = join(evidence, `${name}.png`);
		writeFileSync(rawPath, bytes.replaceAll(homedir(), "~"));
		const xterm = spawnSync(
			process.execPath,
			[join(root, "scripts", "qa", "xterm-render.mjs"), "render", rawPath, "--cols", String(COLS), "--rows", String(ROWS), "--out-json", gridPath, "--out-html", htmlPath, "--title", `Senpi /btw during eval ${name}`],
			{ cwd: root, encoding: "utf8" },
		);
		const shot =
			chrome === undefined
				? undefined
				: spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1100,620", "--virtual-time-budget=2000", `--screenshot=${screenshotPath}`, pathToFileURL(resolve(htmlPath)).href], { encoding: "utf8" });
		return { ok: xterm.status === 0 && existsSync(gridPath), shot: shot?.status === 0 && existsSync(screenshotPath), error: xterm.stderr || xterm.stdout };
	};
	const live = renderFrame("live", liveRaw || raw);
	const done = renderFrame("done", finalRaw || raw);
	const liveBuffer = await replayBuffer(root, liveRaw || raw);
	const doneBuffer = await replayBuffer(root, finalRaw || raw);
	writeFileSync(join(evidence, "live-buffer.txt"), `${liveBuffer.join("\n").replaceAll(homedir(), "~")}\n`);
	writeFileSync(join(evidence, "done-buffer.txt"), `${doneBuffer.join("\n").replaceAll(homedir(), "~")}\n`);

	const panelHeaders = countRows(liveBuffer, `btw: ${QUESTION}`);
	const panelEnds = countRows(liveBuffer, BTW_END);
	const evalRowCopies = Array.from({ length: EVAL_LINES }, (_, line) => countEvalRow(doneBuffer, line));
	const violations = await frameViolations(root, liveRaw || raw, btwAt, settledAt);
	writeFileSync(join(evidence, "frame-violations.json"), `${JSON.stringify(violations, null, 2)}\n`);
	const repeatedEvalRows = evalRowCopies.filter((copies) => copies > 1).length;
	checks.ok("scenario completed without runtime error", runError === undefined, runError instanceof Error ? runError.message : "");
	checks.ok("the btw side query reached the fake provider", (server?.requests.length ?? 0) >= 3, `requests=${server?.requests.length ?? 0}`);
	checks.ok("xterm.js rendered the live and done frames", live.ok && done.ok, live.error || done.error);
	checks.ok("no frame from /btw on paints eval rows into the panel or repeats a panel row, and every frame after the answer shows the panel", violations.length === 0, `badFrames=${violations.length}${violations[0] ? ` first=${JSON.stringify(violations[0])}` : ""}`);
	checks.ok("the panel header is in the buffer exactly once while the eval runs", panelHeaders === 1, `copies=${panelHeaders}`);
	checks.ok("the panel's last answer row is in the buffer exactly once", panelEnds === 1, `copies=${panelEnds}`);
	checks.ok("no eval output row is written twice", repeatedEvalRows === 0, `rowsWithCopies=${repeatedEvalRows}`);
	checks.ok("every eval output row reaches the buffer", evalRowCopies.every((copies) => copies >= 1), `missing=${evalRowCopies.filter((copies) => copies === 0).length}`);
	checks.ok("the panel header is in the buffer exactly once after the turn", countRows(doneBuffer, `btw: ${QUESTION}`) === 1, `copies=${countRows(doneBuffer, `btw: ${QUESTION}`)}`);
	const frameBegins = liveRaw.split("\x1b[?2026h").length - 1;
	const frameEnds = liveRaw.split("\x1b[?2026l").length - 1;
	checks.ok("every synchronized frame in the live capture was finished (the one in flight at capture aside)", frameBegins > 0 && frameBegins - frameEnds <= 1, `begins=${frameBegins} ends=${frameEnds}`);
	checks.ok("Chrome produced both screenshots", live.shot && done.shot);
	checks.ok("all spawned resources and auth guard cleaned", Object.values(cleanup).every(Boolean), JSON.stringify(cleanup));
	const result = checks.finish();

	writeFileSync(join(evidence, "command.txt"), `${COMMAND}\n`);
	writeFileSync(
		join(evidence, "requests.json"),
		`${JSON.stringify((server?.requests ?? []).map((request) => ({ url: request.url, toolNames: Array.isArray(request.tools) ? request.tools.map((tool) => tool.function?.name ?? tool.name) : [] })), null, 2)}\n`,
	);
	writeFileSync(join(evidence, "run.json"), `${JSON.stringify({ cols: COLS, rows: ROWS, catchUpReplay }, null, 2)}\n`);
	writeFileSync(join(evidence, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
	writeFileSync(join(evidence, "checks.json"), `${JSON.stringify(result.rows, null, 2)}\n`);
	if (runError) writeFileSync(join(evidence, "error.txt"), `${runError instanceof Error ? runError.stack : String(runError)}\n`);
	process.stderr.write(`evidence: ${evidence}\n`);
	process.exit(result.passed ? 0 : 1);
}

await main();
