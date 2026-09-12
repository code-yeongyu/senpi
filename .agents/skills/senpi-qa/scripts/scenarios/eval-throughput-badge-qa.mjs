#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
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
const FINAL_MARKER = "EVAL-THROUGHPUT-DONE";
const COMMAND =
	"node .agents/skills/senpi-qa/scripts/scenarios/eval-throughput-badge-qa.mjs --self-test --evidence eval-throughput-badge";

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
	const id = `senpi-qa-eval-throughput-${process.pid}`;
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
	const checks = recordedChecks("eval-throughput-badge-qa.mjs --self-test");
	const guard = guardRealAuth();
	const root = repoRoot();
	const evidence = evidenceDir(evidenceSlug);
	const box = makeSandbox("eval-throughput-badge");
	writeFileSync(join(box.cwd, "note.txt"), "throughput-qa\n");

	let server;
	let term;
	let raw = "";
	let finalRaw = "";
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
								summary: "measure eval nested tool throughput",
								code: [
									'const note = await tool.read({ path: "note.txt" });',
									'const shell = await tool.bash({ command: "printf throughput-qa" });',
									'"tools-done";',
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
				"Run the eval throughput probe.",
			],
			{
				name: "xterm-color",
				cols: COLS,
				rows: ROWS,
				cwd: box.cwd,
				env: hermeticEnv(box.env),
				pipePath: join(box.dir, "eval-throughput-pty.ans"),
			},
		);
		term.onData((data) => {
			raw += data;
		});
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

	const rawPath = join(evidence, "eval-throughput-badge.ans");
	const gridPath = join(evidence, "eval-throughput-badge.grid.json");
	const htmlPath = join(evidence, "eval-throughput-badge.html");
	const screenshotPath = join(evidence, "eval-throughput-badge.png");
	const transcriptPath = join(evidence, "eval-throughput-badge.txt");
	writeFileSync(rawPath, finalRaw);

	const xterm = spawnSync(
		process.execPath,
		[
			join(root, "scripts", "qa", "xterm-render.mjs"),
			"render",
			rawPath,
			"--cols",
			String(COLS),
			"--rows",
			String(ROWS),
			"--out-json",
			gridPath,
			"--out-html",
			htmlPath,
			"--title",
			"Senpi eval throughput badge",
		],
		{ cwd: root, encoding: "utf8" },
	);
	const grid = existsSync(gridPath) ? JSON.parse(readFileSync(gridPath, "utf8")) : undefined;
	const visibleRows = grid ? gridRows(grid) : [];
	const visibleText = visibleRows.join("\n");
	writeFileSync(transcriptPath, `${visibleText}\n`);
	const header = visibleRows.find((row) => row.includes("eval js done")) ?? "";
	const rate = header.match(/\b\d+\.\d{2} calls\/s\b/u)?.[0];
	const agentRequests =
		server?.requests.filter(
			(request) =>
				Array.isArray(request.tools) &&
				request.tools.some((tool) => (tool.function?.name ?? tool.name) === "eval"),
		) ?? [];
	const chrome = chromeExecutable();
	const screenshot =
		chrome === undefined
			? undefined
			: spawnSync(
					chrome,
					[
						"--headless=new",
						"--disable-gpu",
						"--hide-scrollbars",
						"--window-size=1280,720",
						"--virtual-time-budget=2000",
						`--screenshot=${screenshotPath}`,
						pathToFileURL(resolve(htmlPath)).href,
					],
					{ encoding: "utf8" },
				);

	checks.ok("scenario completed without runtime error", runError === undefined, runError instanceof Error ? runError.message : "");
	checks.ok(
		"fake provider handled eval and final agent turns",
		agentRequests.length === 2,
		`agentRequests=${agentRequests.length} totalRequests=${server?.requests.length ?? 0}`,
	);
	checks.ok("xterm.js rendered raw PTY bytes", xterm.status === 0 && grid !== undefined, xterm.stderr || xterm.stdout);
	checks.ok("final grid contains completed eval header", header.includes("eval js done ✓"), header);
	checks.ok("final grid contains exact nested call count", header.includes("2 calls"), header);
	checks.ok("final grid contains finite two-decimal calls/s", rate !== undefined, header);
	checks.ok("final grid contains elapsed time after throughput", /calls\/s · (?:<1s|\d+(?:s|m|h)(?: \d+[sm])?)/u.test(header), header);
	checks.ok("Chrome produced xterm screenshot", screenshot?.status === 0 && existsSync(screenshotPath), screenshot?.stderr ?? "");
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
