#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
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
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

const API = "openai-completions";
const COLS = 120;
const ROWS = 34;
const FINAL_MARKER = "EVAL-HEADLINE-DONE";
const SUMMARY = "Count the files in the sandbox, slowly";
const BADGE = String.raw`(?: \([^)]*\))?`;
const LIVE_HEADER = new RegExp(`eval js${BADGE} running[^·]{0,4}· [2-5]s`, "u");
const DONE_HEADER = new RegExp(`eval js${BADGE} done`, "u");
const COMMAND =
	"node .agents/skills/senpi-qa/scripts/scenarios/eval-live-headline-qa.mjs --self-test --evidence eval-live-headline";

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

function waitForCapture(term, read, predicate, timeoutMs, label) {
	return new Promise((resolveWait, rejectWait) => {
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			dataDisposable.dispose();
			exitDisposable.dispose();
			if (error) rejectWait(error);
			else resolveWait();
		};
		const inspect = () => {
			if (predicate(stripAnsi(read()))) finish();
		};
		const dataDisposable = term.onData(inspect);
		const exitDisposable = term.onExit(() => finish(new Error(`TUI exited while waiting for ${label}`)));
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), timeoutMs);
		inspect();
	});
}

function waitForExit(term, timeoutMs) {
	return new Promise((resolveWait) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			disposable.dispose();
			resolveWait(exited);
		};
		const disposable = term.onExit(() => finish(true));
		const timer = setTimeout(() => finish(false), timeoutMs);
	});
}

async function spawnTerminal(command, args, options) {
	if (process.platform !== "darwin") {
		const ptyModule = await import("node-pty");
		const pty = ptyModule.default ?? ptyModule;
		return pty.spawn(command, args, options);
	}
	const id = `senpi-qa-eval-headline-${process.pid}`;
	const session = id;
	const startChannel = `${id}-start`;
	const exitChannel = `${id}-exit`;
	const pipePath = options.pipePath;
	writeFileSync(pipePath, "");
	const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
	const commandLine = [command, ...args].map(quote).join(" ");
	const envNames = [
		"SENPI_CODING_AGENT_DIR",
		"SENPI_CODING_AGENT_SESSION_DIR",
		"HOME",
		"USERPROFILE",
		"PI_OFFLINE",
		"PI_TELEMETRY",
		"SENPI_OMO_LOCAL_UPDATE",
		"PAGER",
		"GIT_PAGER",
		"PATH",
		"TERM",
		"COLORTERM",
	];
	const envPrefix = envNames
		.filter((name) => options.env[name] !== undefined)
		.map((name) => `${name}=${quote(options.env[name])}`)
		.join(" ");
	const shell = `tmux wait-for ${quote(startChannel)}; ${envPrefix} ${commandLine}; status=$?; tmux wait-for -S ${quote(exitChannel)}; exit $status`;
	const runTmux = (tmuxArgs, allowFailure = false) => {
		const result = spawnSync("tmux", tmuxArgs, { encoding: "utf8" });
		if (!allowFailure && result.status !== 0) {
			throw new Error(`tmux ${tmuxArgs[0]} failed: ${result.stderr || result.stdout}`);
		}
	};
	runTmux([
		"new-session",
		"-d",
		"-s",
		session,
		"-x",
		String(options.cols),
		"-y",
		String(options.rows),
		"-c",
		options.cwd,
		"/bin/sh",
		"-lc",
		shell,
	]);
	runTmux(["pipe-pane", "-O", "-t", session, `cat > ${quote(pipePath)}`]);
	const exitWaiter = spawn("tmux", ["wait-for", exitChannel], { stdio: "ignore" });
	const dataListeners = new Set();
	const exitListeners = new Set();
	let offset = 0;
	let exited = false;
	const emitNewData = () => {
		const data = readFileSync(pipePath);
		if (data.length <= offset) return;
		const chunk = data.subarray(offset).toString();
		offset = data.length;
		for (const listener of dataListeners) listener(chunk);
	};
	const watcher = watch(pipePath, emitNewData);
	exitWaiter.once("exit", (exitCode, signal) => {
		emitNewData();
		exited = true;
		for (const listener of exitListeners) listener({ exitCode: exitCode ?? 1, signal: signal ?? 0 });
	});
	runTmux(["wait-for", "-S", startChannel]);
	return {
		onData(listener) {
			dataListeners.add(listener);
			return { dispose: () => dataListeners.delete(listener) };
		},
		onExit(listener) {
			if (exited) queueMicrotask(() => listener({ exitCode: 0, signal: 0 }));
			exitListeners.add(listener);
			return { dispose: () => exitListeners.delete(listener) };
		},
		write(data) {
			if (data === "\x03\x03") {
				runTmux(["send-keys", "-t", session, "C-c", "C-c"], true);
				return;
			}
			const text = data.endsWith("\r") ? data.slice(0, -1) : data;
			if (text.length > 0) runTmux(["send-keys", "-t", session, "-l", text]);
			if (data.endsWith("\r")) runTmux(["send-keys", "-t", session, "-l", "\r"]);
		},
		kill() {
			emitNewData();
			watcher.close();
			runTmux(["kill-session", "-t", session], true);
			runTmux(["wait-for", "-S", exitChannel], true);
			exitWaiter.kill();
		},
	};
}

function chromeExecutable() {
	const candidates = [
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter((candidate) => typeof candidate === "string");
	return candidates.find((candidate) => existsSync(candidate));
}

function gridRows(grid) {
	return grid.cells.map((row) => row.map((cell) => cell.glyph).join("").trimEnd());
}

function sanitizedRequests(requests) {
	return requests.map((request) => ({
		method: request.method,
		url: request.url,
		model: request.model,
		toolNames: Array.isArray(request.tools) ? request.tools.map((tool) => tool.function?.name ?? tool.name) : [],
	}));
}

async function main() {
	installCleanupHooks();
	const checks = recordedChecks("eval-live-headline-qa.mjs --self-test");
	const guard = guardRealAuth();
	const root = repoRoot();
	const evidence = evidenceDir(evidenceSlug);
	const box = makeSandbox("eval-live-headline");
	writeFileSync(join(box.cwd, "note.txt"), "headline-qa\n");

	let server;
	let term;
	let raw = "";
	let finalRaw = "";
	let liveRaw = "";
	let runError;
	const cleanup = {
		ptyExited: false,
		serverStopped: false,
		sandboxRemoved: false,
		authUnchanged: false,
	};

	try {
		server = await startFakeModelServer({
			turns: [
				{
					toolCalls: [
						{
							name: "eval",
							args: {
								language: "js",
								summary: SUMMARY,
								code: [
									'const { readdir } = await import("node:fs/promises");',
									"await new Promise((resolve) => setTimeout(resolve, 6_000));",
									'(await readdir(".")).length;',
								].join("\n"),
							},
						},
					],
				},
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
				"Run the eval headline probe.",
			],
			{
				name: "xterm-color",
				cols: COLS,
				rows: ROWS,
				cwd: box.cwd,
				env: hermeticEnv(box.env),
				pipePath: join(box.dir, "eval-headline-pty.ans"),
			},
		);
		term.onData((data) => {
			raw += data;
		});
		await waitForCapture(term, () => raw, (text) => LIVE_HEADER.test(text), 120_000, "running eval row after 2s");
		liveRaw = raw;
		await waitForCapture(term, () => raw, (text) => text.includes(FINAL_MARKER), 120_000, "final model marker");
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
		} else cleanup.ptyExited = true;
		if (server) {
			await server.stop().catch(() => {});
			cleanup.serverStopped = true;
		} else cleanup.serverStopped = true;
		box.cleanup();
		cleanup.sandboxRemoved = !existsSync(box.dir);
		try {
			cleanup.authUnchanged = guard.assertUnchanged();
		} catch {}
	}
	if (finalRaw.length === 0) finalRaw = raw;

	const chrome = chromeExecutable();
	const renderFrame = (name, bytes) => {
		const rawPath = join(evidence, `${name}.ans`);
		const gridPath = join(evidence, `${name}.grid.json`);
		const htmlPath = join(evidence, `${name}.html`);
		const screenshotPath = join(evidence, `${name}.png`);
		// The runtime badge names the interpreter's absolute path; the evidence is public, so the home directory is redacted.
		writeFileSync(rawPath, bytes.replaceAll(homedir(), "~"));
		const xterm = spawnSync(
			process.execPath,
			[join(root, "scripts", "qa", "xterm-render.mjs"), "render", rawPath, "--cols", String(COLS), "--rows", String(ROWS), "--out-json", gridPath, "--out-html", htmlPath, "--title", `Senpi eval ${name}`],
			{ cwd: root, encoding: "utf8" },
		);
		const grid = existsSync(gridPath) ? JSON.parse(readFileSync(gridPath, "utf8")) : undefined;
		const rows = grid ? gridRows(grid) : [];
		writeFileSync(join(evidence, `${name}.txt`), `${rows.join("\n")}\n`);
		const shot =
			chrome === undefined
				? undefined
				: spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,720", "--virtual-time-budget=2000", `--screenshot=${screenshotPath}`, pathToFileURL(resolve(htmlPath)).href], { encoding: "utf8" });
		return { ok: xterm.status === 0 && grid !== undefined, rows, shot: shot?.status === 0 && existsSync(screenshotPath), error: xterm.stderr || xterm.stdout };
	};
	const live = renderFrame("live", liveRaw || raw);
	const done = renderFrame("done", finalRaw);
	const liveHeader = live.rows.find((row) => LIVE_HEADER.test(row)) ?? "";
	const doneIndex = done.rows.findIndex((row) => DONE_HEADER.test(row));
	const agentRequests =
		server?.requests.filter(
			(request) =>
				Array.isArray(request.tools) &&
				request.tools.some((tool) => (tool.function?.name ?? tool.name) === "eval"),
		) ?? [];

	checks.ok("scenario completed without runtime error", runError === undefined, runError instanceof Error ? runError.message : "");
	checks.ok(
		"fake provider handled eval and final agent turns",
		agentRequests.length === 2,
		`agentRequests=${agentRequests.length} totalRequests=${server?.requests.length ?? 0}`,
	);
	checks.ok("xterm.js rendered both frames", live.ok && done.ok, live.error || done.error);
	checks.ok("live row leads with the summary", new RegExp(`[╭╶]─ \\S ${SUMMARY} · eval js`, "u").test(liveHeader), liveHeader);
	checks.ok("live row shows elapsed time", /· [2-5]s/u.test(liveHeader), liveHeader);
	checks.ok("live row hides the code", !live.rows.join("\n").includes("setTimeout(resolve"), live.rows.filter((row) => row.includes("setTimeout")).join(" | "));
	checks.ok("done row keeps its header, summary line and code", doneIndex >= 0 && (done.rows[doneIndex + 1] ?? "").includes(SUMMARY) && done.rows.join("\n").includes("setTimeout(resolve"), done.rows.slice(Math.max(0, doneIndex), doneIndex + 4).join(" | "));
	checks.ok("Chrome produced both screenshots", live.shot && done.shot);
	checks.ok("all spawned resources and auth guard cleaned", Object.values(cleanup).every(Boolean), JSON.stringify(cleanup));
	const result = checks.finish();

	writeFileSync(join(evidence, "command.txt"), `${COMMAND}\n`);
	writeFileSync(join(evidence, "requests.json"), `${JSON.stringify(sanitizedRequests(server?.requests ?? []), null, 2)}\n`);
	writeFileSync(join(evidence, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
	writeFileSync(join(evidence, "checks.json"), `${JSON.stringify(result.rows, null, 2)}\n`);
	if (runError) writeFileSync(join(evidence, "error.txt"), `${runError instanceof Error ? runError.stack : String(runError)}\n`);
	process.stderr.write(`evidence: ${evidence}\n`);
	process.exit(result.passed ? 0 : 1);
}

await main();
