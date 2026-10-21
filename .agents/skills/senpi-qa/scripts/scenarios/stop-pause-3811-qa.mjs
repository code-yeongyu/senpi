#!/usr/bin/env node
// senpi#3811: in the real TUI, Stop (Escape) during a streaming reply pauses the session. A background terminal job that
// finishes after the Stop is held as a notice (no new model request, the footer shows the held update), and a
// typed message resumes with one turn. Frames are rendered through xterm.js and screenshotted.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliEntry, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, stripAnsi, tsxEntry } from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { chromeExecutable, spawnTerminal, waitForCapture, waitForExit } from "./eval-live-terminal.mjs";

const API = "openai-completions";
const COLS = 110;
const ROWS = 30;
const LATE_MARKER = "LATE-BG-JOB-DONE";
const RESUMED_MARKER = "RESUMED-AFTER-MESSAGE";
const STREAM_MARKER = "STREAMING-REPLY";
const COMMAND = "node .agents/skills/senpi-qa/scripts/scenarios/stop-pause-3811-qa.mjs --self-test --evidence stop-pause-3811";

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

async function reapProcessGroup(pid) {
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
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
	const deadline = Date.now() + 5_000;
	while (alive() && Date.now() < deadline) await new Promise((resolveTick) => setTimeout(resolveTick, 50));
	return !alive();
}

// Aperiodic, deterministic filler: a repeated phrase now trips the engine's collapse-repetition stream rule (ttsr),
// which interrupts the slow reply before the Stop can land.
function slowFiller() {
	const words = ["reading", "the", "build", "log", "while", "tests", "settle", "into", "a", "quiet", "state", "before", "checking", "each", "module", "for", "drift", "and", "noting", "what", "changed", "since", "lunch"];
	let seed = 3811;
	const out = [];
	for (let i = 0; i < 160; i++) {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		out.push(words[seed % words.length]);
	}
	return out.join(" ");
}

const isTurnRequest = (request) => !JSON.stringify(request.body?.messages?.[0] ?? "").includes("Generate a concise title");
const turnRequests = (server) => (server?.requests ?? []).filter(isTurnRequest).length;

async function main() {
	installCleanupHooks();
	const checks = recordedChecks("stop-pause-3811-qa.mjs --self-test");
	const guard = guardRealAuth();
	const root = repoRoot();
	const evidence = evidenceDir(evidenceSlug);
	const box = makeSandbox("stop-pause-3811");
	let server;
	let term;
	let raw = "";
	const frames = {};
	let requestsAtPause = -1;
	let requestsAfterLateWake = -1;
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
								summary: "Start a background job that finishes after the Stop",
								code: `const job = await tool.bash({ command: "sleep 12; echo ${LATE_MARKER}", run_in_background: true });\nconsole.log(job.text);`,
							},
						},
					],
				},
				{ text: `${STREAM_MARKER} ${slowFiller()}`, chunks: 60, chunkDelayMs: 500 },
				{ text: RESUMED_MARKER },
				{ text: "spare turn" },
			],
		});
		writeMockModelsJson(box.agentDir, server, API);
		const preset = API_PRESETS[API];
		term = await spawnTerminal(
			process.execPath,
			[tsxEntry(root), "--tsconfig", join(root, "tsconfig.json"), cliEntry(root), "--no-context-files", "--no-skills", "--approve", "--provider", preset.provider, "--model", preset.modelId, "Start the background job and wait."],
			{ name: "xterm-color", cols: COLS, rows: ROWS, cwd: box.cwd, env: hermeticEnv(box.env), pipePath: join(box.dir, "stop-pause-pty.ans"), sessionName: `senpi-qa-stop-pause-${process.pid}` },
		);
		term.onData((data) => {
			raw += data;
		});
		await waitForCapture(term, () => raw, (text) => text.includes(STREAM_MARKER), 120_000, "the slow reply streaming");
		term.write("\x1b");
		await waitForCapture(term, () => raw, (text) => /Paused/u.test(text), 60_000, "the Paused footer after Stop");
		frames.stopped = raw;
		requestsAtPause = turnRequests(server);
		await waitForCapture(term, () => raw, (text) => /1 update held/u.test(text), 60_000, "the late background completion held as a notice");
		frames.held = raw;
		requestsAfterLateWake = turnRequests(server);
		term.write("carry on\r");
		await waitForCapture(term, () => raw, (text) => text.includes(RESUMED_MARKER), 120_000, "the resumed turn");
		frames.resumed = raw;
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
			if (typeof term.pid === "number") cleanup.ptyExited &&= await reapProcessGroup(term.pid);
		} else cleanup.ptyExited = true;
		if (server) await server.stop().catch(() => {});
		cleanup.serverStopped = true;
		box.cleanup();
		cleanup.sandboxRemoved = !existsSync(box.dir);
		try {
			cleanup.authUnchanged = guard.assertUnchanged();
		} catch {}
	}

	const chrome = chromeExecutable();
	const render = (name, bytes) => {
		const rawPath = join(evidence, `${name}.ans`);
		const htmlPath = join(evidence, `${name}.html`);
		const gridPath = join(evidence, `${name}.grid.json`);
		const shotPath = join(evidence, `${name}.png`);
		writeFileSync(rawPath, bytes.replaceAll(homedir(), "~"));
		const xterm = spawnSync(process.execPath, [join(root, "scripts", "qa", "xterm-render.mjs"), "render", rawPath, "--cols", String(COLS), "--rows", String(ROWS), "--out-json", gridPath, "--out-html", htmlPath, "--title", `senpi#3811 ${name}`], { cwd: root, encoding: "utf8" });
		const shot = chrome === undefined ? undefined : spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1200,700", "--virtual-time-budget=2000", `--screenshot=${shotPath}`, pathToFileURL(resolve(htmlPath)).href], { encoding: "utf8" });
		return xterm.status === 0 && shot?.status === 0 && existsSync(shotPath);
	};
	writeFileSync(join(evidence, "transcript.txt"), stripAnsi(raw).replaceAll(homedir(), "~"));
	const tailOf = (request) => {
		const messages = Array.isArray(request.body?.messages) ? request.body.messages : [];
		return messages.slice(-3).map((message) => ({ role: message.role, content: JSON.stringify(message.content ?? message.tool_calls ?? "").slice(0, 400) }));
	};
	writeFileSync(join(evidence, "requests.json"), `${JSON.stringify((server?.requests ?? []).map((request, index) => ({ index, at: request.at, tail: tailOf(request) })), null, 2).replaceAll(homedir(), "~")}\n`);
	const rendered = Object.entries(frames).map(([name, bytes]) => render(name, bytes));
	const text = stripAnsi(raw);
	const modelRequests = turnRequests(server);
	checks.ok("scenario completed without runtime error", runError === undefined, runError instanceof Error ? runError.message : "");
	checks.ok("the Stop showed the Paused footer", /Paused/u.test(stripAnsi(frames.stopped ?? "")));
	checks.ok("the late background completion made no model request", requestsAtPause >= 1 && requestsAfterLateWake === requestsAtPause, `atPause=${requestsAtPause} afterLateWake=${requestsAfterLateWake}`);
	checks.ok("the footer counted the held update", /1 update held/u.test(stripAnsi(frames.held ?? "")));
	checks.ok("a typed message resumed with exactly one more model request", text.includes(RESUMED_MARKER) && modelRequests === requestsAtPause + 1, `requests=${modelRequests}`);
	const resumedRequest = JSON.stringify((server?.requests ?? []).filter(isTurnRequest).at(-1)?.body?.messages ?? []);
	checks.ok("the resumed request carries the held background notice and the typed message", resumedRequest.includes(LATE_MARKER) && resumedRequest.includes("carry on"));
	checks.ok("xterm.js rendered and Chrome screenshotted every frame", rendered.length === 3 && rendered.every(Boolean), `frames=${Object.keys(frames).join(",")}`);
	checks.ok("all spawned resources and auth guard cleaned", Object.values(cleanup).every(Boolean), JSON.stringify(cleanup));
	const result = checks.finish();
	writeFileSync(join(evidence, "command.txt"), `${COMMAND}\n`);
	writeFileSync(join(evidence, "checks.json"), `${JSON.stringify(result, null, 2)}\n`);
	process.exit(result.passed ? 0 : 1);
}

await main();
