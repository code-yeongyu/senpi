#!/usr/bin/env node
/**
 * Real native-PTY regression proof for #1076.
 *
 * Resumes a 5,000-message sandbox session at both 80 and 120 columns. The
 * resize, scroll-to-top, and live prompt are triggered by the actual tail-frame
 * PTY output, not a delay, while the container still has deferred history.
 */
import { createWriteStream, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
	cliEntry,
	evidenceDir,
	guardRealAuth,
	makeSandbox,
	repoRoot,
	stripAnsi,
	tsxEntry,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { teardownPty } from "../lib/tui-resume-teardown.mjs";

const require = createRequire(import.meta.url);
const ROWS = 34;
const MESSAGE_COUNT = 5000;
const SESSION_ID = "issue-1076-resume";
const HEAD_MARKER = "Issue1076FullHistoryHeadA1B2";
const TAIL_MARKER = "Issue1076InitialTailE5F6";
const SESSION_LAST_MARKER = "Issue1076SessionLastG7H8";
const LIVE_MARKER = "Issue1076LiveAppendI9J0";
const BOOT_TIMEOUT_MS = 60_000;
const RESUME_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 180_000;
const COMMAND = "node .agents/skills/senpi-qa/scripts/scenarios/issue-1076-qa.mjs --evidence issue-1076 --self-test";

function parseArgs(argv) {
	let evidence;
	let targetRoot;
	let selfTest = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--self-test") {
			selfTest = true;
			continue;
		}
		if (arg === "--evidence" || arg === "--target-root") {
			const value = argv[++index];
			if (!value) throw new Error(`${arg} requires a value`);
			if (arg === "--evidence") evidence = value;
			else targetRoot = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	if (!evidence) throw new Error("--evidence is required");
	return { evidence, selfTest, targetRoot };
}

function ensureNodePtySpawnHelperExecutable() {
	if (process.platform === "win32") return;
	const { chmodSync, statSync } = require("node:fs");
	const packagePath = require.resolve("node-pty/package.json");
	const helper = join(dirname(packagePath), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	if (!existsSync(helper)) return;
	const mode = statSync(helper).mode & 0o777;
	if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
}

async function loadNodePty() {
	ensureNodePtySpawnHelperExecutable();
	const mod = await import("node-pty");
	return mod.default ?? mod;
}

function attachStream(term, events) {
	let exit;
	let resolveExit;
	const exitPromise = new Promise((resolve) => {
		resolveExit = resolve;
	});
	const stream = { raw: "", exit: undefined, exitPromise };
	term.onData((data) => {
		stream.raw += data;
		events.push({ type: "write", data });
		for (const listener of [...listeners]) listener();
	});
	term.onExit((event) => {
		exit = event;
		stream.exit = event;
		resolveExit(event);
		for (const listener of [...listeners]) listener();
	});
	const listeners = new Set();
	return {
		stream,
		waitFor(predicate, timeoutMs, label) {
			return new Promise((resolve, reject) => {
				let settled = false;
				const finish = (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					listeners.delete(inspect);
					if (error) reject(error);
					else resolve(stream.raw);
				};
				const inspect = () => {
					if (predicate(stream.raw)) finish();
					else if (exit) finish(new Error(`${label}: PTY exited before the expected output`));
				};
				const timer = setTimeout(() => finish(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
				listeners.add(inspect);
				inspect();
			});
		},
	};
}

async function writeSession(path, cwd) {
	const stream = createWriteStream(path);
	const write = async (record) => {
		if (!stream.write(`${JSON.stringify(record)}\n`)) await once(stream, "drain");
	};
	const timestamp = 1_800_000_000_000;
	await write({ type: "session", version: 3, id: SESSION_ID, timestamp: new Date(timestamp).toISOString(), cwd });
	let parentId = null;
	for (let index = 1; index <= MESSAGE_COUNT; index += 1) {
		const historyMarker = `Issue1076History-${String(index).padStart(4, "0")}`;
		const text =
			index === 1
				? `${HEAD_MARKER} ${historyMarker}`
				: index === 4996
					? `${TAIL_MARKER} ${historyMarker}`
						: index === MESSAGE_COUNT
							? `${SESSION_LAST_MARKER} ${historyMarker}`
							: historyMarker;
			const messageTimestamp = timestamp + index;
			const id = `message-${index}`;
			await write({
				type: "message",
				id,
				parentId,
				timestamp: new Date(messageTimestamp).toISOString(),
				message: { role: "user", content: [{ type: "text", text }], timestamp: messageTimestamp },
			});
			parentId = id;
		}
	stream.end();
	await finished(stream);
}

function check(rows, name, pass, detail = "") {
	rows.push({ name, pass: Boolean(pass), detail });
	process.stdout.write(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}\n`);
}

function sanitizedRequests(requests) {
	return requests.map((request) => ({ method: request.method, url: request.url, model: request.model, stream: request.stream }));
}

function writeRenderObserver(box, root, logPath) {
	const componentUrl = pathToFileURL(
		join(root, "packages", "coding-agent", "src", "modes", "interactive", "components", "progressive-transcript-container.ts"),
	).href;
	const source = `
import { appendFileSync } from "node:fs";
import { ProgressiveTranscriptContainer } from ${JSON.stringify(componentUrl)};

const logPath = ${JSON.stringify(logPath)};
const originalRender = ProgressiveTranscriptContainer.prototype.render;
ProgressiveTranscriptContainer.prototype.render = function(width) {
	const beforeFullyHydrated = this.isFullyHydrated;
	const lines = originalRender.call(this, width);
	const marker = lines.join("\\n").match(/Issue1076History-(\\d+)/u);
	appendFileSync(logPath, JSON.stringify({
		width,
		beforeFullyHydrated,
		afterFullyHydrated: this.isFullyHydrated,
		firstPersistedIndex: marker === null ? null : Number(marker[1]),
	}) + "\\n");
	return lines;
};

export default function issue1076RenderObserver() {}
`;
	const path = join(box.dir, "issue-1076-render-observer.mjs");
	writeFileSync(path, source);
	return path;
}

function readRenderObservations(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function runWidth({ root, evidence, initialCols, resizeCols, server }) {
	const box = makeSandbox(`issue-1076-${initialCols}`);
	const guard = guardRealAuth();
	const events = [];
	const actions = [];
	const initialRequestCount = server.requests.length;
	let sequence = 0;
	let term;
	let driver;
	let runError;
	let receipt;
	const event = (type, detail) => actions.push({ sequence: ++sequence, type, ...detail });
	try {
		const cwd = realpathSync(box.cwd);
		await writeSession(join(box.sessionDir, `2027-01-15T00-00-01-000Z_${SESSION_ID}.jsonl`), cwd);
		writeMockModelsJson(box.agentDir, server, "openai-completions");
		const observationPath = join(box.dir, "render-observations.jsonl");
		const observerExtension = writeRenderObserver(box, root, observationPath);
		const pty = await loadNodePty();
		term = pty.spawn(
			process.execPath,
			[
				tsxEntry(root),
				"--tsconfig",
				join(root, "tsconfig.json"),
				cliEntry(root),
				"--no-context-files",
				"--no-skills",
				"--no-extensions",
				"--extension",
				observerExtension,
				"--approve",
				"--tui-mode",
				"fullscreen",
				"--provider",
				"mock",
				"--model",
				"mock-model",
			],
			{ name: "xterm-256color", cols: initialCols, rows: ROWS, cwd, env: hermeticEnv({ ...box.env, TERM: "xterm-256color", COLORTERM: "truecolor" }) },
		);
		driver = attachStream(term, events);
		const { stream } = driver;
		await driver.waitFor((raw) => stripAnsi(raw).includes("senpi v"), BOOT_TIMEOUT_MS, `boot at ${initialCols} columns`);
		event("boot", { cols: initialCols, rows: ROWS, sentinel: "senpi v" });

		const selector = driver.waitFor(
			(raw) => stripAnsi(raw).includes("Resume Session") && stripAnsi(raw).includes(HEAD_MARKER),
			RESUME_TIMEOUT_MS,
			`resume selector at ${initialCols} columns`,
		);
		term.write("/resume\r");
		event("input", { data: "/resume\\r" });
		await selector;

		const resumeOffset = stream.raw.length;
		const tailFrame = driver.waitFor(
			(raw) => stripAnsi(raw.slice(resumeOffset)).includes(TAIL_MARKER),
			RESUME_TIMEOUT_MS,
			`initial tail frame at ${initialCols} columns`,
		);
		term.write("\r");
		event("input", { data: "\\r", select: "latest" });
		await tailFrame;
		event("tail-frame", { marker: TAIL_MARKER, rawOffset: stream.raw.length, cols: initialCols, rows: ROWS });

		const triggerOffset = stream.raw.length;
		const fullHistory = driver.waitFor(
			(raw) => stripAnsi(raw.slice(triggerOffset)).includes(HEAD_MARKER),
			COMPLETE_TIMEOUT_MS,
			`full history reveal at ${initialCols} columns`,
		);
		const liveAppend = driver.waitFor(
			(raw) => stripAnsi(raw.slice(triggerOffset)).includes(LIVE_MARKER),
			COMPLETE_TIMEOUT_MS,
			`live append at ${initialCols} columns`,
		);
		term.resize(resizeCols, ROWS);
		events.push({ type: "resize", cols: resizeCols, rows: ROWS, snapshot: "resize-trigger" });
		event("resize", { cols: resizeCols, rows: ROWS, after: "tail-frame" });
		term.write("\x1b[H");
		event("input", { data: "\\u001b[H", key: "home" });
		term.write("append the issue-1076 live marker\r");
		event("input", { data: "append the issue-1076 live marker\\r", after: "resize" });
		await fullHistory;
		term.write("\x1b[F");
		event("input", { data: "\\u001b[F", key: "end", after: "full-history" });
		await liveAppend;
		event("complete", { headMarker: HEAD_MARKER, liveMarker: LIVE_MARKER, cols: resizeCols, rows: ROWS });

		const headOffset = stream.raw.indexOf(HEAD_MARKER, triggerOffset);
		const liveOffset = stream.raw.indexOf(LIVE_MARKER, triggerOffset);
		const observations = readRenderObservations(observationPath);
		const initialTailRender = observations.find(
			(observation) => observation.width === initialCols && !observation.beforeFullyHydrated && observation.firstPersistedIndex !== null,
		);
		const incompleteResizeRender = observations.find(
			(observation) => observation.width === resizeCols && !observation.beforeFullyHydrated && observation.firstPersistedIndex !== null,
		);
		const checks = [];
		check(checks, `initial ${initialCols}-column tail rendered before trigger`, stream.raw.slice(resumeOffset, triggerOffset).includes(TAIL_MARKER));
		check(checks, `resize caused an actual incomplete TUI render at ${resizeCols} columns`, incompleteResizeRender !== undefined, JSON.stringify(incompleteResizeRender));
		check(
			checks,
			`incomplete ${resizeCols}-column resize did not publish any partial prefix`,
			initialTailRender !== undefined && incompleteResizeRender?.firstPersistedIndex === initialTailRender.firstPersistedIndex,
			`initial=${JSON.stringify(initialTailRender)} resize=${JSON.stringify(incompleteResizeRender)}`,
		);
		check(checks, `full history reached the top at ${resizeCols} columns`, headOffset >= 0, `headOffset=${headOffset}`);
		check(checks, `live append survived hydration at ${resizeCols} columns`, liveOffset >= 0, `liveOffset=${liveOffset}`);
		const requestCount = server.requests.length - initialRequestCount;
		check(checks, `one local fake-model request completed at ${initialCols} columns`, requestCount === 1, `requests=${requestCount}`);

		const prefix = join(evidence, `resume-${initialCols}-to-${resizeCols}`);
		writeFileSync(`${prefix}.ans`, stream.raw);
		events.at(-1).snapshot = "complete";
		writeFileSync(`${prefix}.events.json`, `${JSON.stringify({ cols: initialCols, rows: ROWS, scrollback: 20_000, events }, null, 2)}\n`);
		writeFileSync(`${prefix}.actions.json`, `${JSON.stringify(actions, null, 2)}\n`);
		writeFileSync(`${prefix}.render-observations.json`, `${JSON.stringify(observations, null, 2)}\n`);
		const replay = spawnSync(process.execPath, [join(root, "scripts", "qa", "xterm-render.mjs"), "replay", `${prefix}.events.json`, "--out-json", `${prefix}.grid.json`], {
			cwd: root,
			encoding: "utf8",
		});
		check(checks, `ordered ${initialCols}/${resizeCols} replay produced grids`, replay.status === 0, replay.stderr || replay.stdout);
		writeFileSync(`${prefix}.replay.log`, `${replay.stdout}${replay.stderr}`);
		const rendered = spawnSync(
			process.execPath,
			[
				join(root, "scripts", "qa", "xterm-render.mjs"),
				"render",
				`${prefix}.ans`,
				"--cols",
				String(resizeCols),
				"--rows",
				String(ROWS),
				"--out-json",
				`${prefix}.final.grid.json`,
				"--out-html",
				`${prefix}.html`,
				"--title",
				`Issue #1076 resume ${initialCols} to ${resizeCols}`,
			],
			{ cwd: root, encoding: "utf8" },
		);
		check(checks, `xterm HTML capture produced at ${resizeCols} columns`, rendered.status === 0, rendered.stderr || rendered.stdout);
		writeFileSync(`${prefix}.render.log`, `${rendered.stdout}${rendered.stderr}`);
		writeFileSync(`${prefix}.checks.json`, `${JSON.stringify(checks, null, 2)}\n`);
		return { checks, prefix };
	} catch (error) {
		runError = error;
		return { checks: [{ name: `runtime at ${initialCols} columns`, pass: false, detail: error instanceof Error ? error.stack : String(error) }], prefix: join(evidence, `resume-${initialCols}-to-${resizeCols}`) };
	} finally {
		if (term && driver) {
			try {
				receipt = await teardownPty(term, driver.stream);
			} catch (error) {
				receipt = error.receipt ?? { ptyExited: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		box.cleanup();
		const cleanup = {
			ptyExited: receipt?.ptyExited ?? !term,
			sandboxRemoved: !existsSync(box.dir),
			authUnchanged: guard.assertUnchanged(),
			runError: runError instanceof Error ? runError.message : undefined,
		};
		writeFileSync(join(evidence, `resume-${initialCols}-to-${resizeCols}.cleanup.json`), `${JSON.stringify(cleanup, null, 2)}\n`);
		if (runError && driver) {
			writeFileSync(join(evidence, `resume-${initialCols}-to-${resizeCols}.failure.ans`), driver.stream.raw);
		}
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const root = realpathSync(options.targetRoot ?? repoRoot());
	if (!existsSync(cliEntry(root)) || !existsSync(tsxEntry(root))) {
		throw new Error(`--target-root must contain source CLI and tsx dependencies: ${root}`);
	}
	const evidence = evidenceDir(options.evidence);
	const server = await startFakeModelServer({ turns: [{ text: LIVE_MARKER }] });
	let results;
	try {
		results = [
			await runWidth({ root, evidence, initialCols: 80, resizeCols: 120, server }),
			await runWidth({ root, evidence, initialCols: 120, resizeCols: 80, server }),
		];
	} finally {
		await server.stop();
	}
	const checks = results.flatMap((result) => result.checks);
	const passed = checks.every((item) => item.pass);
	writeFileSync(join(evidence, "command.txt"), `${COMMAND}\n`);
	writeFileSync(join(evidence, "requests.json"), `${JSON.stringify(sanitizedRequests(server.requests), null, 2)}\n`);
	writeFileSync(join(evidence, "summary.json"), `${JSON.stringify({ selfTest: options.selfTest, passed, checks, widths: [80, 120], rows: ROWS }, null, 2)}\n`);
	process.stderr.write(`evidence: ${evidence}\n`);
	if (!passed) process.exitCode = 1;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
