#!/usr/bin/env node
// senpi#4074: a schedule_prompt job that comes due while its session is open and the agent is inside a tool
// call is delivered by that session itself and steered into the running turn, with no `senpi schedule run`
// runner at all. The real TUI runs in a PTY against the fake model server: the model schedules a prompt 15s
// out, then starts a 25s eval, and the run proves (a) the pending area shows the prompt as `Steering:`, never
// `Follow-up:`, and (b) the model request right after the tool result already carries it. Frames are
// rendered through xterm.js to PNG.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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
	tsxEntry,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { chromeExecutable, spawnTerminal, waitForCapture, waitForExit } from "./eval-live-terminal.mjs";

const API = "openai-completions";
const POST_TOOL_REQUEST_COUNT = 4;
const COLS = 110;
const ROWS = 30;
const PROMPT_MARKER = "SCHEDMARK-4074";
const SCHEDULED_OK = "SCHEDULED-OK";
const AFTER_TOOL = "AFTER-TOOL-REPLY";
const TOOL_SECONDS = 25;
const DELAY_SECONDS = 15;
const COMMAND = "node .agents/skills/senpi-qa/scripts/scenarios/schedule-live-steer-qa.mjs --self-test --evidence schedule-live-steer";

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
			process.stdout.write(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}\n`);
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

const isTitleRequest = (request) => JSON.stringify(request.messages?.[0] ?? "").includes("Generate a concise title");
const agentRequestCount = (server) => (server?.requests ?? []).filter((request) => !isTitleRequest(request)).length;

const messageText = (message) =>
	typeof message?.content === "string"
		? message.content
		: Array.isArray(message?.content)
			? message.content.map((part) => part?.text ?? "").join("")
			: "";

/** In the last request that ends after a tool result, whether the scheduled prompt follows that result. */
function tickPlacement(requests) {
	for (const [index, request] of [...requests.entries()].reverse()) {
		const messages = Array.isArray(request.messages) ? request.messages : [];
		const toolIndex = messages.findLastIndex((message) => message.role === "tool");
		if (toolIndex < 0) continue;
		const assistantAfterTool = messages.slice(toolIndex + 1).some((message) => message.role === "assistant");
		if (assistantAfterTool) continue;
		const tickAfterTool = messages
			.slice(toolIndex + 1)
			.some((message) => message.role === "user" && messageText(message).includes(PROMPT_MARKER));
		return { requestIndex: index, tickAfterTool };
	}
	return undefined;
}

async function main() {
	installCleanupHooks();
	const checks = recordedChecks("schedule-live-steer-qa.mjs --self-test");
	const guard = guardRealAuth();
	const root = repoRoot();
	const evidence = evidenceDir(evidenceSlug);
	const box = makeSandbox("schedule-live-steer");

	let server;
	let term;
	let raw = "";
	let queuedRaw = "";
	let finalRaw = "";
	let sawFollowUp = false;
	let toolCallSeenAt = 0;
	let postToolRequestAt = 0;
	let runError;
	// The TUI repaints only changed cells, so sentences are asserted on an emulated screen, not on raw bytes.
	const { Terminal } = createRequire(join(root, "packages", "tui", "package.json"))("@xterm/headless");
	const screen = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10_000, allowProposedApi: true });
	let screenText = "";
	const screenListeners = new Set();
	const waitScreen = (predicate, timeoutMs, label) =>
		new Promise((resolveWait, rejectWait) => {
			const check = () => {
				if (!predicate()) return;
				clearTimeout(timer);
				screenListeners.delete(check);
				resolveWait();
			};
			const timer = setTimeout(() => {
				screenListeners.delete(check);
				rejectWait(new Error(`Timed out waiting for ${label}`));
			}, timeoutMs);
			screenListeners.add(check);
			check();
		});
	const readScreen = () => {
		const buffer = screen.buffer.active;
		const rows = [];
		for (let row = 0; row < buffer.length; row++) rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
		return rows.join("\n");
	};
	const cleanup = { ptyExited: false, serverStopped: false, sandboxRemoved: false, authUnchanged: false };

	try {
		server = await startFakeModelServer({
			turns: [
				{ toolCalls: [{ name: "schedule_prompt", args: { action: "create", prompt: PROMPT_MARKER, delaySeconds: DELAY_SECONDS } }] },
				{ text: SCHEDULED_OK },
				{
					toolCalls: [
						{
							name: "eval",
							args: {
								language: "js",
								summary: "Run the long job",
								code: `await new Promise((resolve) => setTimeout(resolve, ${TOOL_SECONDS * 1000}));\nconsole.log("LONG-JOB-DONE");`,
							},
						},
					],
				},
				{ text: AFTER_TOOL },
				{ text: "EXTRA-REPLY" },
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
			],
			{
				name: "xterm-color",
				cols: COLS,
				rows: ROWS,
				cwd: box.cwd,
				env: hermeticEnv(box.env),
				pipePath: join(box.dir, "schedule-live-steer-pty.ans"),
				sessionName: `senpi-qa-schedule-steer-${process.pid}`,
			},
		);
		term.onData((data) => {
			raw += data;
			screen.write(data, () => {
				screenText = readScreen();
				const queued = screenText.split("\n").filter((line) => line.includes("Scheduled prompt") || line.includes(PROMPT_MARKER));
				if (queued.some((line) => line.trimStart().startsWith("Follow-up:"))) sawFollowUp = true;
				if (toolCallSeenAt === 0 && screenText.includes("Run the long job")) toolCallSeenAt = Date.now();
				if (postToolRequestAt === 0 && agentRequestCount(server) >= POST_TOOL_REQUEST_COUNT) postToolRequestAt = Date.now();
				for (const listener of [...screenListeners]) listener();
			});
		});
		await waitScreen(() => screenText.includes("mock-model"), 60_000, "TUI boot");
		term.write("schedule the check");
		await waitScreen(() => screenText.includes("schedule the check"), 30_000, "the typed request");
		// Enter typed while startup is still finishing is dropped by the editor, so submit until the turn answers.
		for (let attempt = 0; ; attempt++) {
			term.write("\r");
			const answered = await waitScreen(() => screenText.includes(SCHEDULED_OK), 5_000, "the scheduling turn")
				.then(() => true)
				.catch(() => false);
			if (answered) break;
			if (attempt >= 11) throw new Error("the scheduling request was never accepted");
		}
		term.write("run the long job\r");
		await waitScreen(() => screenText.includes("Run the long job"), 60_000, "the long eval call");
		queuedRaw = raw;
		await waitScreen(() => screenText.includes(AFTER_TOOL), 120_000, "the reply after the tool result");
		await waitForCapture(term, () => raw, () => agentRequestCount(server) >= POST_TOOL_REQUEST_COUNT, 30_000, "the post-tool request");
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
			if (typeof term.pid === "number") cleanup.ptyExited &&= await reapProcessGroup(term.pid);
		} else cleanup.ptyExited = true;
		if (server) await server.stop().catch(() => {});
		screen.dispose();
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
			[join(root, "scripts", "qa", "xterm-render.mjs"), "render", rawPath, "--cols", String(COLS), "--rows", String(ROWS), "--out-json", gridPath, "--out-html", htmlPath, "--title", `Senpi scheduled prompt steer ${name}`],
			{ cwd: root, encoding: "utf8" },
		);
		const shot =
			chrome === undefined
				? undefined
				: spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1200,720", "--virtual-time-budget=2000", `--screenshot=${screenshotPath}`, pathToFileURL(resolve(htmlPath)).href], { encoding: "utf8" });
		return { ok: xterm.status === 0 && existsSync(gridPath), shot: shot?.status === 0 && existsSync(screenshotPath), error: xterm.stderr || xterm.stdout };
	};
	const queued = renderFrame("queued", queuedRaw || raw);
	const done = renderFrame("done", finalRaw || raw);

	const placement = tickPlacement((server?.requests ?? []).filter((request) => !isTitleRequest(request)));
	checks.ok("scenario completed without runtime error", runError === undefined, runError instanceof Error ? runError.message : "");
	const toolSeconds = postToolRequestAt > 0 && toolCallSeenAt > 0 ? (postToolRequestAt - toolCallSeenAt) / 1000 : undefined;
	checks.ok(
		"the steered message cut the eval's foreground wait short (a follow-up would let it run the full time)",
		toolSeconds !== undefined && toolSeconds > 0 && toolSeconds < TOOL_SECONDS - 3,
		`eval ran ~${toolSeconds?.toFixed(1)}s of ${TOOL_SECONDS}s`,
	);
	checks.ok("the scheduled prompt is never shown as a Follow-up", !sawFollowUp);
	checks.ok(
		"the request right after the tool result already carries the scheduled prompt",
		placement?.tickAfterTool === true,
		placement === undefined ? "no post-tool request" : `request=${placement.requestIndex}`,
	);
	checks.ok("xterm.js rendered the queued and done frames", queued.ok && done.ok, queued.error || done.error);
	checks.ok("Chrome produced both screenshots", queued.shot && done.shot);
	checks.ok("all spawned resources and auth guard cleaned", Object.values(cleanup).every(Boolean), JSON.stringify(cleanup));
	const result = checks.finish();

	writeFileSync(join(evidence, "command.txt"), `${COMMAND}\n`);
	writeFileSync(
		join(evidence, "requests.json"),
		`${JSON.stringify((server?.requests ?? []).map((request) => ({ url: request.url, messages: (request.messages ?? []).map((message) => ({ role: message.role, text: messageText(message).slice(0, 200) })) })), null, 2).replaceAll(homedir(), "~")}\n`,
	);
	writeFileSync(join(evidence, "screen.txt"), `${screenText.replaceAll(homedir(), "~")}\n`);
	writeFileSync(join(evidence, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
	writeFileSync(join(evidence, "checks.json"), `${JSON.stringify(result.rows, null, 2)}\n`);
	if (runError) writeFileSync(join(evidence, "error.txt"), `${runError instanceof Error ? runError.stack : String(runError)}\n`);
	process.stderr.write(`evidence: ${evidence}\n`);
	process.exit(result.passed ? 0 : 1);
}

await main();
