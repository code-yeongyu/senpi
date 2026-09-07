#!/usr/bin/env node
/**
 * Native-PTY TUI proof for #891 reasoning capabilities.
 *
 * Drives the source CLI under Bun inside a sandbox. The built-in Xiaomi and
 * Alibaba model records remain authoritative; only their sandbox provider URLs
 * and keys point at the local fake server.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/issue-891-tui-qa.mjs --evidence issue-891-tui
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	makeSandbox,
	repoRoot,
	stripAnsi,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { teardownPty } from "../lib/tui-resume-teardown.mjs";

const require = createRequire(import.meta.url);
const BUN = process.env.SENPI_QA_BUN || "bun";
const XIAOMI = { provider: "xiaomi", model: "mimo-v2.5-pro" };
const ALIBABA = { provider: "alibaba-token-plan", model: "qwen3.8-max" };
const ROWS = 32;
const BOOT_TIMEOUT_MS = 60_000;

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

function sourceSha(root) {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function validateBun(command) {
	let version;
	try {
		version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
	} catch (error) {
		throw new Error(`Bun executable is unavailable: ${command} (${error instanceof Error ? error.message : String(error)})`);
	}
	const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
	if (!match) throw new Error(`Bun returned an unrecognized version: ${version}`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major < 1 || (major === 1 && minor < 4)) {
		throw new Error(`Bun >=1.4 is required, got ${version} from ${command}`);
	}
	return { command, version };
}

function writeOverrides(agentDir, baseUrl) {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[XIAOMI.provider]: { baseUrl, apiKey: "xiaomi-local-qa", api: "openai-completions" },
					[ALIBABA.provider]: { baseUrl, apiKey: "alibaba-local-qa", api: "openai-completions" },
				},
			},
			null,
			2,
		),
	);
}

function ensureNodePtySpawnHelperExecutable() {
	if (process.platform === "win32") return;
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

function normalized(raw) {
	// The TUI emits OSC hyperlinks between wrapped rows; remove them before
	// matching human-visible notification text across a resize boundary.
	return stripAnsi(raw.replace(/\u001b\][^\u0007]*\u0007/g, "")).replace(/\s+/g, " ");
}

function synchronizedFrameEnd(raw) {
	const begin = raw.lastIndexOf("\x1b[?2026h");
	const end = raw.lastIndexOf("\x1b[?2026l");
	return begin >= 0 && end > begin ? end + "\x1b[?2026l".length : -1;
}

function waitForText(stream, text, { after = 0, label, timeoutMs = BOOT_TIMEOUT_MS, exactBorder = false } = {}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const inspect = () => {
			const frameEnd = synchronizedFrameEnd(stream.raw);
			const captured = stream.raw.slice(after);
			const matches = exactBorder
				? stripAnsi(captured).match(/\u2500+/g)?.at(-1) === text
				: normalized(captured).includes(text);
			if (matches && frameEnd >= after) {
				finish(resolve, { rawCutoff: stream.raw.length, eventCutoff: stream.events.length, frameEnd });
			} else if (stream.exit) {
				finish(reject, new Error(`${label}: PTY exited before ${JSON.stringify(text)} in a complete synchronized frame`));
			}
		};
		const timer = setTimeout(() => finish(reject, new Error(`${label} timed out waiting for ${JSON.stringify(text)} in a complete synchronized frame`)), timeoutMs);
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stream.listeners.delete(inspect);
			fn(value);
		};
		stream.listeners.add(inspect);
		inspect();
	});
}

function createStream(term, events) {
	const stream = { raw: "", events, exit: null, listeners: new Set(), exitPromise: null, resolveExit: null };
	stream.exitPromise = new Promise((resolve) => {
		stream.resolveExit = resolve;
	});
	term.onData((data) => {
		events.push({ type: "write", data });
		stream.raw += data;
		for (const listener of [...stream.listeners]) listener();
	});
	term.onExit((event) => {
		stream.exit = event;
		stream.resolveExit(event);
		for (const listener of [...stream.listeners]) listener();
	});
	return stream;
}

function recordAction(actions, session, type, detail = {}) {
	actions.push({ at: new Date().toISOString(), session, type, ...detail });
}

async function openTui({ root, box, bun, env, model, actions, name, runs }) {
	const pty = await loadNodePty();
	const term = pty.spawn(
		bun.command,
		[
			join(root, "packages", "coding-agent", "src", "cli.ts"),
			"--no-context-files",
			"--no-skills",
			"--approve",
			"--provider",
			model.provider,
			"--model",
			model.model,
			"/reasoning",
		],
		{ name: "xterm-256color", cols: 80, rows: ROWS, cwd: box.cwd, env },
	);
	const events = [{ type: "resize", cols: 80, rows: ROWS }];
	const stream = createStream(term, events);
	const run = { term, stream, events, name, closed: false };
	runs.push(run);
	recordAction(actions, name, "spawn", { command: bun.command, bunVersion: bun.version, cols: 80, rows: ROWS, model: `${model.provider}/${model.model}` });
	// InteractiveMode awaits initial messages before it enters getUserInput(), so
	// this initial CLI command is a deterministic ready signal for PTY writes.
	const ready = await waitForText(stream, "Reasoning: ", { label: `${name} initial /reasoning` });
	recordAction(actions, name, "ready", { sentinel: "Reasoning: ", ...ready });
	return run;
}

async function resize(run, cols, actions) {
	const geometry = waitForText(run.stream, "\u2500".repeat(cols), {
		after: run.stream.raw.length,
		label: `${run.name} ${cols}-column redraw`,
		exactBorder: true,
	});
	run.term.resize(cols, ROWS);
	run.events.push({ type: "resize", cols, rows: ROWS });
	recordAction(actions, run.name, "resize", { cols, rows: ROWS });
	const frame = await geometry;
	recordAction(actions, run.name, "resize-rendered", { cols, rows: ROWS, ...frame });
}

async function command(run, text, expected, actions) {
	const after = run.stream.raw.length;
	const observed = waitForText(run.stream, expected, { after, label: `${run.name} ${text}` });
	const input = `${text}\r`;
	run.inputs ??= [];
	run.inputs.push(input);
	run.term.write(input);
	recordAction(actions, run.name, "write", { data: input, expects: expected });
	const observedFrame = await observed;
	run.lastObserved = observedFrame;
	recordAction(actions, run.name, "observed", { text: expected, ...observedFrame });
}

async function closeTui(run, actions) {
	if (run.closed) return run.receipt;
	run.receipt = await teardownPty(run.term, run.stream);
	run.closed = true;
	recordAction(actions, run.name, "pty-exit", run.receipt);
	return run.receipt;
}

function captureRun(run, actions) {
	const rawCutoff = run.lastObserved?.rawCutoff;
	const eventCutoff = run.lastObserved?.eventCutoff;
	if (!Number.isInteger(rawCutoff) || !Number.isInteger(eventCutoff) || synchronizedFrameEnd(run.stream.raw.slice(0, rawCutoff)) < 0) {
		throw new Error(`${run.name}: cannot capture before a complete synchronized frame`);
	}
	run.capture = { rawCutoff, eventCutoff };
	recordAction(actions, run.name, "capture", run.capture);
}

function writeRunEvidence(evidence, run) {
	const raw = run.stream.raw.slice(0, run.capture?.rawCutoff);
	const events = run.events.slice(0, run.capture?.eventCutoff);
	writeFileSync(join(evidence, `${run.name}.ans`), raw);
	writeFileSync(join(evidence, `${run.name}.txt`), stripAnsi(raw));
	writeFileSync(join(evidence, `${run.name}-events.json`), `${JSON.stringify({ cols: 80, rows: ROWS, events }, null, 2)}\n`);
	return { raw, events };
}

async function main() {
	const root = repoRoot();
	const evidence = evidenceDir(argument("--evidence", "issue-891-tui"));
	const checks = createChecks("issue-891-tui-qa");
	const guard = guardRealAuth();
	const box = makeSandbox("issue-891-tui-qa");
	const env = hermeticEnv({ ...box.env, TERM: "xterm-256color", COLORTERM: "truecolor", PI_SKIP_VERSION_CHECK: "1" });
	const actions = [];
	const runs = [];
	let server;
	let failure;
	let serverStopped = false;
	let sandboxRemoved = false;
	let authUnchanged = false;

	try {
		const bun = validateBun(BUN);
		server = await startFakeModelServer();
		writeOverrides(box.agentDir, server.url);

		const xiaomi = await openTui({ root, box, bun, env, model: XIAOMI, actions, name: "xiaomi", runs });
		await resize(xiaomi, 120, actions);
		await command(xiaomi, "/reasoning off", "Reasoning: off.", actions);
		await resize(xiaomi, 80, actions);
		await command(xiaomi, "/reasoning on", "Reasoning: on (high).", actions);
		await resize(xiaomi, 120, actions);
		await command(
			xiaomi,
			"/efforts low",
			"Reasoning effort is not configurable for xiaomi/mimo-v2.5-pro; this model supports on/off only. Use /reasoning on or /reasoning off.",
			actions,
		);
		captureRun(xiaomi, actions);
		await closeTui(xiaomi, actions);

		const alibaba = await openTui({ root, box, bun, env, model: ALIBABA, actions, name: "alibaba", runs });
		await resize(alibaba, 120, actions);
		await command(alibaba, "/efforts low", "Reasoning effort: low. Available: low, medium, xhigh.", actions);
		await resize(alibaba, 80, actions);
		await command(alibaba, "/reasoning off", "Reasoning: off.", actions);
		await command(alibaba, "/reasoning on", "Reasoning: on (low).", actions);
		captureRun(alibaba, actions);
		await closeTui(alibaba, actions);

		const settings = JSON.parse(readFileSync(join(box.agentDir, "settings.json"), "utf8"));
		checks.ok(
			"graded Alibaba effort persists in sandbox settings",
			settings.modelThinkingLevels?.[`${ALIBABA.provider}/${ALIBABA.model}`] === "low",
			JSON.stringify(settings.modelThinkingLevels),
		);

		const alibabaRestart = await openTui({ root, box, bun, env, model: ALIBABA, actions, name: "alibaba-restart", runs });
		await resize(alibabaRestart, 120, actions);
		await command(alibabaRestart, "/reasoning", "Reasoning: on (low).", actions);
		captureRun(alibabaRestart, actions);
		await closeTui(alibabaRestart, actions);

		const capturedRaw = (run) => run.stream.raw.slice(0, run.capture.rawCutoff);
		const capturedEvents = (run) => run.events.slice(0, run.capture.eventCutoff);
		const replay = (run) => capturedEvents(run).filter((event) => event.type === "write").map((event) => event.data).join("");
		checks.ok("native PTY ran with Bun >=1.4", true, `${bun.command} ${bun.version}`);
		checks.ok("on/off model accepted /reasoning off and on", normalized(capturedRaw(xiaomi)).includes("Reasoning: off.") && normalized(capturedRaw(xiaomi)).includes("Reasoning: on (high)."));
		checks.ok("on/off model refused /efforts low", normalized(capturedRaw(xiaomi)).includes("this model supports on/off only."));
		checks.ok("graded Alibaba model accepted /efforts low", normalized(capturedRaw(alibaba)).includes("Reasoning effort: low. Available: low, medium, xhigh."));
		checks.ok("restart observed the persisted graded Alibaba level", normalized(capturedRaw(alibabaRestart)).includes("Reasoning: on (low)."));
		checks.ok(
			"captured ANSI prefixes equal ordered PTY output writes",
			runs.every((run) => capturedEvents(run).some((event) => event.type === "write") && replay(run) === capturedRaw(run)),
			runs.map((run) => `${run.name}:${capturedEvents(run).filter((event) => event.type === "write").length}`).join(", "),
		);
		checks.ok(
			"PTY replay events exclude keyboard writes",
			runs.every((run) => capturedEvents(run).every((event) => event.type !== "write" || !run.inputs?.includes(event.data))),
		);
		checks.ok("commands made no external provider request", server.requests.length === 0, String(server.requests.length));
	} catch (error) {
		failure = error;
	} finally {
		for (const run of [...runs].reverse()) {
			try {
				await closeTui(run, actions);
			} catch (error) {
				failure ??= error;
			}
			writeRunEvidence(evidence, run);
		}
		if (server) {
			try {
				await server.stop();
				serverStopped = true;
			} catch (error) {
				failure ??= error;
			}
		}
		box.cleanup();
		sandboxRemoved = !existsSync(box.dir);
		try {
			authUnchanged = guard.assertUnchanged();
		} catch (error) {
			failure ??= error;
		}
		writeFileSync(join(evidence, "action-log.json"), `${JSON.stringify(actions, null, 2)}\n`);
		writeFileSync(join(evidence, "source-sha.txt"), `${sourceSha(root)}\n`);
		writeFileSync(
			join(evidence, "cleanup.json"),
			`${JSON.stringify({ runs: runs.map(({ name, receipt }) => ({ name, receipt })), serverStopped, sandboxRemoved, authUnchanged }, null, 2)}\n`,
		);
		writeFileSync(join(evidence, "auth-receipt.json"), `${JSON.stringify({ path: guard.path, unchanged: authUnchanged }, null, 2)}\n`);
	}

	checks.ok("all PTYs exited before sandbox cleanup", runs.length === 3 && runs.every((run) => run.receipt?.ptyExited));
	checks.ok("local fake server stopped", serverStopped);
	checks.ok("sandbox removed", sandboxRemoved, box.dir);
	checks.ok("real auth unchanged", authUnchanged, guard.path);
	const checksPassed = checks.finish();
	const passed = !failure && checksPassed;
	writeFileSync(join(evidence, "summary.json"), `${JSON.stringify({ passed, sourceSHA: sourceSha(root), error: failure ? String(failure) : null }, null, 2)}\n`);
	process.stderr.write(`evidence: ${evidence}\n`);
	if (failure) throw failure;
	process.exit(passed ? 0 : 1);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
