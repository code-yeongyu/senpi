#!/usr/bin/env node
/**
 * Real-CLI probe: does cross-model resume preserve conversation context?
 *
 * Starts a fresh `cursor-agent -p` chat whose FIRST user message embeds a
 * unique canary token, then resumes the SAME chat id through a sequence of
 * model switches (A -> B -> C -> A by default) asking for the canary
 * verbatim, and records per run whether the canary came back in the final
 * `result.result` text.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/probes/cursor-cli/resume-model-swap-canary.mjs \
 *     --switches 3 --out .omo/evidence/task-1-cursor-cli-oauth.json
 *
 * Options:
 *   --switches <n>     number of model switches after the initial run (default 3)
 *   --out <path>       JSON report destination (required)
 *   --executable <p>   cursor-agent executable (default: "cursor-agent" from PATH)
 *   --timeout-ms <n>   per-attempt deadline (default 300000)
 *   --models <a,b,c>   override the A/B/C model id rotation
 *   --keep             keep the temp working directory (debugging)
 *
 * Exit codes:
 *   0  probe completed; the canary outcome is data, not a failure
 *   1  infrastructure failure (CLI missing, version probe failed, unexpected)
 *   2  usage error
 *   3  `Error: Your macOS login keychain is locked.` (stderr echoed verbatim;
 *      this script never attempts to unlock anything)
 *   4  auth failure reported by the CLI
 *   5  initial chat could not be established even after one retry
 *
 * Node builtins only. Runs the REAL binary with the REAL login; it is meant
 * for explicit operator invocation, never for automated test gates.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const VERSION_FLOOR = "2026.08.11";
const DEFAULT_MODELS = ["composer-2.5-fast", "gpt-5.6-luna-high", "claude-opus-4-8-thinking-high"];
const KEYCHAIN_LOCKED = "Error: Your macOS login keychain is locked.";
const EXCERPT_LIMIT = 2000;

const children = new Set();
let workdir = null;
let outPath = null;

function usageError(message) {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

function parseArgs(argv) {
	const parsed = {
		switches: 3,
		executable: "cursor-agent",
		timeoutMs: 300_000,
		models: DEFAULT_MODELS,
		keep: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) usageError(`missing value for ${arg}`);
			return argv[++i];
		};
		switch (arg) {
			case "--switches":
				parsed.switches = Number.parseInt(next(), 10);
				if (!Number.isInteger(parsed.switches) || parsed.switches < 1) {
					usageError(`--switches must be a positive integer, got ${parsed.switches}`);
				}
				break;
			case "--out":
				parsed.out = next();
				break;
			case "--executable":
				parsed.executable = next();
				break;
			case "--timeout-ms":
				parsed.timeoutMs = Number.parseInt(next(), 10);
				if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
					usageError(`--timeout-ms must be >= 1000, got ${parsed.timeoutMs}`);
				}
				break;
			case "--models": {
				const models = next()
					.split(",")
					.map((m) => m.trim())
					.filter(Boolean);
				if (models.length < 2) usageError("--models needs at least two comma-separated model ids");
				parsed.models = models;
				break;
			}
			case "--keep":
				parsed.keep = true;
				break;
			default:
				usageError(`unknown argument: ${arg}`);
		}
	}
	if (!parsed.out) usageError("--out <path> is required");
	return parsed;
}

function installSignalCleanup() {
	const cleanup = () => {
		for (const child of children) killGroup(child);
		if (workdir) rmSync(workdir, { recursive: true, force: true });
		process.exit(130);
	};
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
}

function killGroup(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		/* process group already gone */
	}
}

function excerpt(text, limit = EXCERPT_LIMIT) {
	if (typeof text !== "string") return null;
	return text.length > limit ? `${text.slice(0, limit)}\n... [truncated ${text.length - limit} chars]` : text;
}

function classifyAuthFailure(stderr) {
	return /invalid[ _-]?(?:api[ _-]?key|key)|not logged in|unauthorized|status(?: code)?[ :]?401/i.test(stderr ?? "");
}

/**
 * Parse one cursor-agent stream-json stdout blob. Each line may carry a
 * leading elapsed-seconds prefix ("4.097 {...}"); tolerate and strip it.
 */
function parseStream(stdout) {
	const events = { init: null, result: null, assistantText: "", parsedLines: 0, unparsedLines: 0 };
	for (const rawLine of (stdout ?? "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const jsonStart = line.indexOf("{");
		if (jsonStart < 0) {
			events.unparsedLines += 1;
			continue;
		}
		let obj;
		try {
			obj = JSON.parse(line.slice(jsonStart));
		} catch {
			events.unparsedLines += 1;
			continue;
		}
		events.parsedLines += 1;
		if (obj.type === "system" && obj.subtype === "init") events.init = obj;
		if (obj.type === "result") events.result = obj;
		if (obj.type === "assistant" && obj.message?.content) {
			for (const block of obj.message.content) {
				if (block?.type === "text" && typeof block.text === "string") events.assistantText += block.text;
			}
		}
	}
	return events;
}

/** Run one cursor-agent turn; resolves with a normalized attempt record. */
function runAttempt({ executable, cwd, model, prompt, resumeId, timeoutMs }) {
	return new Promise((resolveAttempt) => {
		const args = [];
		if (resumeId) args.push("--resume", resumeId);
		args.push("-p", "--output-format", "stream-json", "--model", model, "--trust", prompt);
		const startedAt = Date.now();
		const child = spawn(executable, args, {
			cwd,
			detached: true, // own process group so timeouts kill the whole tree
			env: { ...process.env, CURSOR_API_KEY: undefined }, // env-key lane must never engage
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child);
			setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* already dead */
				}
			}, 5_000).unref();
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			children.delete(child);
			resolveAttempt({ spawnError: error.message, rc: null, signal: null, timedOut: false, stdout, stderr, wallMs: Date.now() - startedAt });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			children.delete(child);
			resolveAttempt({ spawnError: null, rc: code, signal, timedOut, stdout, stderr, wallMs: Date.now() - startedAt });
		});
	});
}

function summarizeAttempt(attempt, events, canary) {
	const resultText = typeof events?.result?.result === "string" ? events.result.result : null;
	return {
		spawnError: attempt.spawnError,
		rc: attempt.spawnError ? null : attempt.rc,
		signal: attempt.signal,
		timedOut: attempt.timedOut,
		wallMs: attempt.wallMs,
		cliDurationMs: typeof events?.result?.duration_ms === "number" ? events.result.duration_ms : null,
		parsedLines: events?.parsedLines ?? 0,
		unparsedLines: events?.unparsedLines ?? 0,
		hasResultEvent: events?.result != null,
		resultIsError: events?.result?.is_error === true,
		resultSubtype: events?.result?.subtype ?? null,
		resultChars: resultText === null ? null : resultText.length,
		resultExcerpt: resultText === null ? null : excerpt(resultText, 400),
		// Verbatim match against the FINAL result text. rc=0 with an EMPTY
		// result text lands here as false - misleading-success class.
		canaryReturned: typeof resultText === "string" && resultText.length > 0 && resultText.includes(canary),
		canaryInAssistantText: typeof events?.assistantText === "string" && events.assistantText.includes(canary),
		assistantTextChars: events?.assistantText?.length ?? 0,
	};
}

/** A run is transient-failed when the CLI itself failed (rc, stream,
 *  is_error, spawn). rc=0 with an empty-but-present result text is NOT
 *  transient: it is recorded as canaryReturned:false. */
function isTransientFailure(summary) {
	return (
		summary.spawnError !== null ||
		summary.timedOut ||
		summary.rc !== 0 ||
		!summary.hasResultEvent ||
		summary.resultIsError ||
		summary.parsedLines === 0
	);
}

function writeReport(report) {
	if (!report || !outPath) return;
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

function failNow(report, exitCode, message, keep) {
	if (report) writeReport(report);
	if (workdir && !keep) rmSync(workdir, { recursive: true, force: true });
	if (message) process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
	process.exit(exitCode);
}

/** Run one turn with a single retry on transient failure; merge into report. */
async function runTurn(config, canary, report, label, model, prompt, resumeId, chatId = null) {
	const attempts = [];
	let events = null;
	let rawStderr = "";
	for (let i = 0; i < 2; i++) {
		const attempt = await runAttempt({ ...config, model, prompt, resumeId });
		rawStderr = attempt.stderr && attempt.stderr.trim().length > 0 ? attempt.stderr : rawStderr;
		if (attempt.stderr?.includes(KEYCHAIN_LOCKED)) {
			// Environmental lock: echo verbatim, never unlock anything ourselves.
			process.stderr.write(attempt.stderr);
			failNow(report, 3, null, config.keep);
		}
		if (classifyAuthFailure(attempt.stderr)) {
			failNow(report, 4, `cursor-agent auth failure during ${label}:\n${excerpt(attempt.stderr)}`, config.keep);
		}
		events = parseStream(attempt.stdout);
		const summary = summarizeAttempt(attempt, events, canary);
		attempts.push(summary);
		if (!isTransientFailure(summary)) break;
		process.stderr.write(
			`[probe] ${label}: transient failure (rc=${summary.rc ?? "spawn-error"}, timedOut=${summary.timedOut}, ` +
				`hasResult=${summary.hasResultEvent}, is_error=${summary.resultIsError}); ` +
				`${i === 0 ? "retrying once" : "recording failure"}\n`,
		);
	}
	const last = attempts.at(-1);
	const sessionId = events?.init?.session_id ?? events?.result?.session_id ?? null;
	const run = {
		label,
		model,
		initModel: events?.init?.model ?? null,
		apiKeySource: events?.init?.apiKeySource ?? null,
		sessionId,
		resultSessionId: events?.result?.session_id ?? null,
		sessionIdStable: chatId === null ? null : sessionId === chatId,
		canaryReturned: last?.canaryReturned ?? false,
		canaryInAssistantText: last?.canaryInAssistantText ?? false,
		retried: attempts.length > 1,
		attempts,
		// stderr on failure, including the transient stderr a successful retry recovered from
		stderrExcerpt:
			last && (last.rc !== 0 || last.spawnError || last.timedOut || attempts.length > 1)
				? excerpt(rawStderr || "(no stderr)")
				: null,
	};
	report.runs.push(run);
	return run;
}

async function main() {
	const config = parseArgs(process.argv.slice(2));
	outPath = resolve(config.out);
	installSignalCleanup();

	// --- Preflight: executable + version (floor is warn-only) ---
	const versionProbe = spawnSync(config.executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
	if (versionProbe.error) {
		process.stderr.write(
			`infrastructure failure: cannot execute ${config.executable} (${versionProbe.error.code ?? versionProbe.error.message}). ` +
				`Install with: curl https://cursor.com/install -fsS | bash  (symlinks ~/.local/bin/cursor-agent; ensure it is on PATH)\n`,
		);
		process.exit(1);
	}
	if (versionProbe.stderr?.includes(KEYCHAIN_LOCKED)) {
		process.stderr.write(versionProbe.stderr);
		process.exit(3);
	}
	const cliVersion = (versionProbe.stdout ?? "").trim();
	const versionBelowFloor = cliVersion.slice(0, VERSION_FLOOR.length) < VERSION_FLOOR;
	if (versionBelowFloor) {
		process.stderr.write(
			`[probe] warning: cursor-agent ${cliVersion || "(unknown)"} is below the known-good floor ${VERSION_FLOOR}\n`,
		);
	}

	// --- Setup: fresh canary + temp working directory ---
	const canary = `CANARY-${randomUUID()}`;
	workdir = mkdtempSync(`${tmpdir()}/cursor-cli-canary-`);
	const runConfig = { ...config, cwd: workdir };

	const report = {
		probe: "resume-model-swap-canary",
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		executable: config.executable,
		cliVersion,
		versionFloor: VERSION_FLOOR,
		versionBelowFloor,
		models: { A: config.models[0], B: config.models[1], C: config.models[2] ?? null },
		switches: config.switches,
		canary,
		workdir: config.keep ? workdir : "(removed after run)",
		runs: [],
	};

	const initialPrompt =
		`This is a context-fidelity test across model switches.\n` +
		`Reference token: ${canary}\n` +
		`Keep this exact token in conversation memory. Do not write it to disk. ` +
		`Reply with exactly: TOKEN STORED`;
	const recallPrompt =
		`Reply with the reference token from my FIRST message in this conversation, ` +
		`verbatim and complete, and nothing else. Do not use any tools.`;

	// --- Initial run (model A): establishes the chat and the canary ---
	const initial = await runTurn(runConfig, canary, report, "initial", config.models[0], initialPrompt, null);
	if (!initial.sessionId) {
		report.summary = { verdict: "inconclusive", reason: "initial chat could not be established" };
		failNow(
			report,
			5,
			`infrastructure failure: initial run produced no session_id after retry ` +
				`(rc=${initial.attempts.at(-1)?.rc}, timedOut=${initial.attempts.at(-1)?.timedOut})`,
			config.keep,
		);
	}
	const chatId = initial.sessionId;

	// --- Switch runs: same chat id, rotating models B, C, A, ... ---
	for (let i = 1; i <= config.switches; i++) {
		const model = config.models[i % config.models.length];
		await runTurn(runConfig, canary, report, `switch-${i}`, model, recallPrompt, chatId, chatId);
	}

	// --- Summary + verdict ---
	const switchRuns = report.runs.filter((r) => r.label.startsWith("switch-"));
	const completed = switchRuns.filter((r) => r.attempts.at(-1)?.hasResultEvent);
	const allReturned = switchRuns.length > 0 && switchRuns.every((r) => r.canaryReturned);
	const anyReturned = switchRuns.some((r) => r.canaryReturned);
	let verdict;
	if (allReturned) verdict = "canary-survives-model-switch";
	else if (completed.length === switchRuns.length && !anyReturned) verdict = "canary-is-lost";
	else if (completed.length === switchRuns.length) verdict = "mixed";
	else verdict = "inconclusive";
	report.summary = {
		runsTotal: report.runs.length,
		switchesRequested: config.switches,
		initialCanaryReturned: initial.canaryReturned,
		switchRunsCompleted: completed.length,
		switchCanaryReturnedCount: switchRuns.filter((r) => r.canaryReturned).length,
		canarySurvivesModelSwitch: allReturned,
		sessionIdStableAllRuns: report.runs.every((r) => r.sessionIdStable !== false),
		verdict,
	};
	writeReport(report);

	process.stdout.write(
		`verdict: ${verdict}\n` +
			`  initial (${config.models[0]}): rc=${initial.attempts.at(-1)?.rc} resultChars=${initial.attempts.at(-1)?.resultChars}\n` +
			switchRuns
				.map(
					(r) =>
						`  ${r.label} (${r.model}): canaryReturned=${r.canaryReturned} sessionIdStable=${r.sessionIdStable} ` +
						`initModel=${JSON.stringify(r.initModel)}`,
				)
				.join("\n") +
			`\nreport: ${outPath}\n`,
	);

	if (!config.keep) rmSync(workdir, { recursive: true, force: true });
	process.exit(0);
}

main().catch((error) => {
	process.stderr.write(`infrastructure failure: ${error?.stack ?? error}\n`);
	if (workdir) rmSync(workdir, { recursive: true, force: true });
	process.exit(1);
});
