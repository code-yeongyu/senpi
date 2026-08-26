#!/usr/bin/env node
/**
 * Todo 3 probe (.omo/plans/cursor-cli-oauth.md): prompt transport ceiling and
 * long-chat context behavior of the locally installed cursor-agent CLI.
 *
 * Phases (all against the real CLI, one temp file-store HOME for the run):
 *   1. CEILING  - binary-search the largest synthetic prompt accepted as the
 *                 final argv element of
 *                 cursor-agent -p <prompt> --output-format stream-json
 *                     --model <model> --trust
 *                 Bracket 1KB..1MB, filler = repeated ASCII words, granularity
 *                 1KB. Acceptance = rc 0 AND a result frame with subtype
 *                 "success" and is_error false (a large prompt that returns
 *                 rc 0 but an error result frame counts as REJECTED at that
 *                 size). Every failing size is retried once before it is
 *                 recorded. OS E2BIG (exec limit) is distinguished from a CLI
 *                 error by the recorded verbatim text.
 *   2. STDIN    - whether -p accepts the prompt via stdin: full --help scan
 *                 plus live attempts (piped stdin with no prompt arg, and "-"
 *                 as the prompt arg). stdinSupported is true only if a stdin
 *                 sentinel comes back in a successful result frame.
 *   3. LONGCHAT - one chat id, up to 12 resumed turns appending ~2KB each via
 *                 --resume, watching for CLI-side compaction signals or
 *                 context/token-limit errors (exact wording recorded).
 *
 * Auth: file-store pattern - temp HOME + keychain-sourced tokens written to
 * <tempHome>/.cursor/auth.json (dir 0700, file 0600, apiKey null,
 * bedrockCredentials null), AGENT_CLI_CREDENTIAL_STORE=file. Token VALUES are
 * never printed anywhere; only byte lengths. Temp dirs are removed on exit and
 * the removal is logged as a receipt.
 *
 * Safety: every invocation has a hard timeout (default 180s) enforced with a
 * SIGKILL to the child's whole process group (cursor-agent is a bash wrapper
 * that spawns a bundled node). Total probe wall time is capped at 15 minutes.
 *
 * Usage:
 *   node prompt-ceiling-probe.mjs --out <report.json> [--cli cursor-agent]
 *                                 [--model composer-2.5-fast] [--self-test]
 *
 * The report JSON contains exactly:
 *   { maxAcceptedPromptBytes, firstFailureError, stdinSupported,
 *     longChatOutcome, contextErrorWording }
 *
 * Exit 0 on completion; non-zero only on infra failure (missing CLI, keychain
 * read failure, unwritable --out).
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Tunables (all wall times are hard caps)
// ---------------------------------------------------------------------------

const BRACKET_LO = 1024; // 1KB
const BRACKET_HI = 1024 * 1024; // 1MB
const GRANULARITY = 1024; // stop the search within 1KB
const MAX_SEARCH_PROBES = 40; // runaway guard on top of the deadline
const INVOCATION_TIMEOUT_MS = 180_000;
const STDIN_TIMEOUT_MS = 90_000;
const HELP_TIMEOUT_MS = 30_000;
const TOTAL_BUDGET_MS = 15 * 60_000; // hard cap for the whole probe
const WALL_MARGIN_MS = 25_000; // reserved for writing the report + cleanup
const STDIN_PHASE_BUDGET_MS = 4 * 60_000;
const LONG_CHAT_RESERVE_MS = 7 * 60_000; // held back from the ceiling search
const LONG_CHAT_RESUME_TURNS = 12; // resumed turns after the initial one

const MODEL_DEFAULT = "composer-2.5-fast";

const STDIN_SENTINEL = "STDINPROBE-4c1a";
const STDIN_PROMPT =
	`[probe] This prompt was delivered on standard input instead of the command line. ` +
	`Reply with exactly: ${STDIN_SENTINEL}`;

// Repeated ASCII words; deliberately free of words that could trip the
// compaction/context signal scans (compact, condense, summarize, truncate...).
const CEILING_FILLER =
	"ceilingprobe filler alpha bravo charlie delta echo foxtrot golf hotel india ";
const CEILING_TAIL =
	"\n\n[probe] Everything above is filler. Ignore it and reply with exactly: OK";
const DISCUSSION_FILLER =
	"synthetic discussion filler alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo ";

// Signals that the CLI itself compacted/trimmed the chat context.
const COMPACT_SIGNAL_RE =
	/compact|condens|summariz|truncat|prun(?:e|ed|ing)|earlier (?:messages|turns|history|context)/i;
// Classifies an observed failure as context/token related (wording is recorded
// verbatim either way).
const CONTEXT_ERROR_RE =
	/(?:context|token)[\s_-]*(?:length|size|limit|window|overflow)|context is too|too many tokens|prompt.{0,30}too (?:large|long)|input.{0,30}too (?:large|long)|exceeds?.{0,40}(?:context|token|limit|maximum)|maximum.{0,30}(?:context|token|input|prompt)|context_length|token limit|input token/i;

// ---------------------------------------------------------------------------
// Global run state
// ---------------------------------------------------------------------------

const START_MS = Date.now();
const HARD_END_MS = START_MS + TOTAL_BUDGET_MS - WALL_MARGIN_MS;

let CLI = "cursor-agent";
let MODEL = MODEL_DEFAULT;
let OUT_PATH = null;
let TEMP_HOME = null;
let WORKDIR = null;
let CURRENT_CHILD = null;
let CLEANED = false;

const BASE_ENV = () => ({
	HOME: TEMP_HOME,
	PATH: process.env.PATH ?? "",
	AGENT_CLI_CREDENTIAL_STORE: "file",
	TERM: "dumb",
});

function elapsedS() {
	return ((Date.now() - START_MS) / 1000).toFixed(1);
}

function log(line) {
	process.stdout.write(`[+${elapsedS()}s] ${line}\n`);
}

function clip(text, max = 400) {
	if (text == null) return null;
	const s = String(text);
	return s.length > max ? `${s.slice(0, max)}...[clipped ${s.length - max} chars]` : s;
}

function remainingWallMs() {
	return HARD_END_MS - Date.now();
}

// Effective per-invocation timeout: never past the hard wall clock.
function effectiveTimeout(requestedMs) {
	const remain = remainingWallMs();
	if (remain < 15_000) return -1; // caller must not start the invocation
	return Math.max(15_000, Math.min(requestedMs, remain));
}

// ---------------------------------------------------------------------------
// Auth: temp file-store HOME sourced from the login keychain
// ---------------------------------------------------------------------------

function readKeychainToken(service) {
	const r = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
		encoding: "utf8",
		timeout: 15_000,
	});
	const value = (r.stdout ?? "").trim();
	if (r.status !== 0 || !value) {
		throw new Error(
			`keychain read failed for "${service}" (rc=${r.status}): ${clip((r.stderr ?? "").trim(), 200) ?? "no stderr"}`,
		);
	}
	return value;
}

function setupTempHome() {
	TEMP_HOME = mkdtempSync(join(tmpdir(), "cursor-probe-home-"));
	chmodSync(TEMP_HOME, 0o700);
	const cursorDir = join(TEMP_HOME, ".cursor");
	mkdirSync(cursorDir, { recursive: true });
	chmodSync(cursorDir, 0o700);

	const accessToken = readKeychainToken("cursor-access-token");
	const refreshToken = readKeychainToken("cursor-refresh-token");
	const authFile = join(cursorDir, "auth.json");
	writeFileSync(
		authFile,
		JSON.stringify({
			accessToken,
			refreshToken,
			apiKey: null,
			bedrockCredentials: null,
		}) + "\n",
	);
	chmodSync(authFile, 0o600);
	log(
		`auth: wrote ${authFile} (mode 0600, dir 0700); accessTokenLen=${accessToken.length} refreshTokenLen=${refreshToken.length} (values never logged)`,
	);

	WORKDIR = mkdtempSync(join(tmpdir(), "cursor-probe-wd-"));
	log(`workdir: ${WORKDIR}`);
}

// ---------------------------------------------------------------------------
// CLI runner: streaming JSONL parse, bounded memory, process-group kill
// ---------------------------------------------------------------------------

function stripDurationPrefix(line) {
	const m = line.match(/^\d+(?:\.\d+)?\s+(?=\{)/);
	return m ? line.slice(m[0].length) : line;
}

/**
 * Runs the CLI once. Returns a summary with parsed essentials; raw stdout is
 * parsed line-by-line so multi-MB prompt echoes never buffer unboundedly.
 */
function runCli(args, opts = {}) {
	const requestedMs = opts.timeoutMs ?? INVOCATION_TIMEOUT_MS;
	const timeoutMs = effectiveTimeout(requestedMs);
	const label = opts.label ?? args.join(" ").slice(0, 120);
	const t0 = Date.now();

	if (timeoutMs < 0) {
		return Promise.resolve({
			label,
			skippedWall: true,
			timedOut: false,
			spawnError: new Error("[probe] wall-clock budget exhausted before invocation"),
			code: null,
			signal: null,
			durationMs: 0,
			eventCounts: {},
			nonJsonLines: 0,
			nonJsonFirst: null,
			initEvent: null,
			resultEvent: null,
			errorEvent: null,
			assistantText: "",
			compactSignalLines: [],
			stderrText: "",
			stdoutBytes: 0,
			stderrBytes: 0,
			stdoutHead: "",
			stdoutFull: "",
		});
	}

	return new Promise((resolve) => {
		let child;
		const summary = {
			label,
			skippedWall: false,
			timedOut: false,
			spawnError: null,
			code: null,
			signal: null,
			durationMs: 0,
			eventCounts: {},
			nonJsonLines: 0,
			nonJsonFirst: null,
			initEvent: null,
			resultEvent: null,
			errorEvent: null,
			assistantText: "",
			compactSignalLines: [],
			stderrText: "",
			stdoutBytes: 0,
			stderrBytes: 0,
			stdoutHead: "",
			stdoutFull: opts.keepStdout ? "" : null,
		};

		const handleLine = (line) => {
			if (!line) return;
			const parsed = stripDurationPrefix(line).trim();
			if (!parsed.startsWith("{")) {
				summary.nonJsonLines++;
				if (!summary.nonJsonFirst) summary.nonJsonFirst = clip(line, 200);
				if (COMPACT_SIGNAL_RE.test(line)) summary.compactSignalLines.push(clip(line, 300));
				return;
			}
			let ev;
			try {
				ev = JSON.parse(parsed);
			} catch {
				summary.nonJsonLines++;
				if (!summary.nonJsonFirst) summary.nonJsonFirst = clip(line, 200);
				return;
			}
			const type = typeof ev.type === "string" ? ev.type : "?";
			summary.eventCounts[type] = (summary.eventCounts[type] ?? 0) + 1;
			if (type === "system" && ev.subtype === "init") {
				summary.initEvent = ev;
			} else if (type === "result") {
				summary.resultEvent = ev;
			} else if (type === "error") {
				if (!summary.errorEvent) summary.errorEvent = ev;
			} else if (type === "assistant") {
				const content = ev.message?.content;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part?.text === "string" &&
							summary.assistantText.length < 65_536
						) {
							summary.assistantText += part.text;
						}
					}
				}
			}
			// Compaction signals: scan frames the model did not author
			// (thinking/assistant text may legitimately say "summarize").
			if (type !== "thinking" && type !== "assistant" && type !== "tool_call") {
				if (COMPACT_SIGNAL_RE.test(parsed)) summary.compactSignalLines.push(clip(parsed, 300));
			}
		};

		try {
			child = spawn(CLI, args, {
				cwd: WORKDIR,
				env: BASE_ENV(),
				detached: true, // own process group: cursor-agent is a bash wrapper -> node
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			summary.spawnError = err;
			summary.durationMs = Date.now() - t0;
			resolve(summary);
			return;
		}
		CURRENT_CHILD = child;

		let stdoutBuf = "";
		let stderrBuf = "";
		let settled = false;

		const killGroup = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
		};

		const timer = setTimeout(() => {
			summary.timedOut = true;
			killGroup();
		}, timeoutMs);

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			summary.durationMs = Date.now() - t0;
			if (CURRENT_CHILD === child) CURRENT_CHILD = null;
			resolve(summary);
		};

		// For spawn errors (E2BIG etc.) "close" may not fire; force-settle.
		let errorFallback = null;
		child.on("error", (err) => {
			summary.spawnError = err;
			errorFallback = setTimeout(finish, 1_500);
		});
		child.on("close", (code, signal) => {
			if (errorFallback) clearTimeout(errorFallback);
			summary.code = code;
			summary.signal = signal;
			finish();
		});

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			summary.stdoutBytes += chunk.length;
			if (summary.stdoutHead.length < 600) summary.stdoutHead += chunk;
			if (opts.keepStdout && summary.stdoutFull.length < 262_144) {
				summary.stdoutFull += chunk;
			}
			stdoutBuf += chunk;
			let idx;
			while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
				handleLine(stdoutBuf.slice(0, idx));
				stdoutBuf = stdoutBuf.slice(idx + 1);
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			summary.stderrBytes += chunk.length;
			if (stderrBuf.length < 16_384) stderrBuf += chunk;
			for (const line of chunk.split("\n")) {
				if (line && COMPACT_SIGNAL_RE.test(line)) {
					summary.compactSignalLines.push(clip(line, 300));
				}
			}
		});
		child.stdin.on("error", () => {}); // EPIPE if the child exits early
		if (opts.stdinData != null) {
			child.stdin.end(opts.stdinData);
		} else {
			child.stdin.end();
		}
	});
}

function firstStderrLine(run) {
	const line = (run.stderrText ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)[0];
	return line ? clip(line) : null;
}

function frameVerbatim(frame) {
	if (!frame) return null;
	if (typeof frame.result === "string" && frame.result) return clip(frame.result);
	if (typeof frame.error === "string") return clip(frame.error);
	if (frame.error?.message) return clip(frame.error.message);
	return clip(JSON.stringify(frame));
}

/**
 * Acceptance per the probe contract: rc 0 AND a success result frame with
 * is_error false. rc 0 with an error result frame counts as REJECTED.
 */
function classifyInvocation(run) {
	if (run.skippedWall) {
		return {
			accepted: false,
			kind: "wall-budget",
			verbatim: "[probe] invocation skipped: probe wall-clock budget exhausted",
		};
	}
	if (run.spawnError) {
		const code = run.spawnError.code ?? "";
		return {
			accepted: false,
			kind: code === "E2BIG" ? "os-e2big" : "spawn-error",
			verbatim: clip(`${run.spawnError.message}${code ? ` (code ${code})` : ""}`),
		};
	}
	if (run.timedOut) {
		return {
			accepted: false,
			kind: "timeout",
			verbatim: `[probe] no completion within ${INVOCATION_TIMEOUT_MS} ms; process group SIGKILLed (inconclusive at this size, treated as rejected)`,
		};
	}
	const result = run.resultEvent;
	if (run.errorEvent && (!result || result.is_error || result.subtype !== "success")) {
		return { accepted: false, kind: "cli-error", verbatim: frameVerbatim(run.errorEvent) };
	}
	if (!result) {
		// Observed on this build: above ~468KB the CLI exits rc=0 with zero
		// bytes on both streams (silent no-op). Record the observed facts.
		const events = Object.entries(run.eventCounts ?? {})
			.map(([t, n]) => `${t}:${n}`)
			.join(",");
		const facts = `CLI produced no result frame: rc=${run.code}, stdout=${run.stdoutBytes ?? 0}B, stderr=${run.stderrBytes ?? 0}B, ${run.durationMs ?? 0} ms, events={${events || "none"}}`;
		return {
			accepted: false,
			kind: "no-result",
			verbatim:
				run.code === 0
					? `${facts} (silent no-op; no error text emitted by the CLI)`
					: `${facts}; stderr=${JSON.stringify(firstStderrLine(run))}`,
		};
	}
	if (result.subtype !== "success" || result.is_error) {
		return {
			accepted: false,
			kind: "cli-error",
			verbatim: frameVerbatim(result) ?? firstStderrLine(run),
		};
	}
	if (run.code !== 0) {
		return {
			accepted: false,
			kind: "cli-error",
			verbatim: firstStderrLine(run) ?? `[probe] success result frame but rc=${run.code}`,
		};
	}
	return { accepted: true, kind: "accepted", verbatim: null };
}

function usageOf(run) {
	const u = run.resultEvent?.usage;
	if (!u) return "-";
	return `in=${u.inputTokens ?? "?"} cacheR=${u.cacheReadTokens ?? "?"} cacheW=${u.cacheWriteTokens ?? "?"} out=${u.outputTokens ?? "?"}`;
}

function totalContextOf(run) {
	const u = run.resultEvent?.usage;
	if (!u) return null;
	const n = (v) => (typeof v === "number" ? v : 0);
	// Anthropic-style semantics: inputTokens counts fresh tokens (including
	// cache writes) and cacheReadTokens is the reused prefix, so the request's
	// context footprint is the sum.
	return n(u.inputTokens) + n(u.cacheReadTokens);
}

// ---------------------------------------------------------------------------
// Prompt builders (pure ASCII so byte length == char length)
// ---------------------------------------------------------------------------

function buildCeilingPrompt(sizeBytes) {
	const fill = CEILING_FILLER.repeat(Math.ceil(sizeBytes / CEILING_FILLER.length) + 1);
	return fill.slice(0, sizeBytes - CEILING_TAIL.length) + CEILING_TAIL;
}

function buildTurnPrompt(turn, marker) {
	const head = `Long-chat context probe, turn ${turn}. Remember this marker for later recall: ${marker}.\n`;
	const tail = `\n\n[probe] The discussion above is filler. Reply with exactly: OK-${turn}`;
	const target = 2048;
	const fillLen = Math.max(0, target - head.length - tail.length);
	const fill = DISCUSSION_FILLER.repeat(Math.ceil(fillLen / DISCUSSION_FILLER.length) + 1);
	return head + fill.slice(0, fillLen) + tail;
}

const randHex = (bytes) => randomBytes(bytes).toString("hex");

// ---------------------------------------------------------------------------
// Phase 1: prompt transport ceiling (binary search)
// ---------------------------------------------------------------------------

async function attemptCeilingSize(size) {
	const args = ["-p", "--output-format", "stream-json", "--model", MODEL, "--trust"];
	const prompt = buildCeilingPrompt(size);
	const label = `ceiling:${size}B`;

	let run = await runCli([...args, prompt], { label });
	let cls = classifyInvocation(run);
	log(
		`ceiling size=${size}B rc=${run.code} kind=${cls.kind} accepted=${cls.accepted} durMs=${run.durationMs} usage=[${usageOf(run)}]` +
			(cls.verbatim ? ` verbatim=${JSON.stringify(clip(cls.verbatim, 260))}` : ""),
	);
	if (!cls.accepted) {
		// Flaky-class defense: retry the boundary size once before recording.
		log(`ceiling size=${size}B rejected (${cls.kind}); retrying once`);
		const run2 = await runCli([...args, prompt], { label: `${label}:retry` });
		const cls2 = classifyInvocation(run2);
		log(
			`ceiling size=${size}B retry rc=${run2.code} kind=${cls2.kind} accepted=${cls2.accepted} durMs=${run2.durationMs} stdout=${run2.stdoutBytes}B stderr=${run2.stderrBytes}B`,
		);
		if (cls2.accepted) {
			cls = cls2;
		} else if (cls.kind === "os-e2big" || cls.kind === "cli-error") {
			// Keep the deterministic-looking first verdict over a timeout retry.
		} else {
			cls = cls2;
		}
	}
	return cls;
}

async function phaseCeiling(deadlineMs) {
	const attempts = [];
	const note = (size, cls) =>
		attempts.push({ size, kind: cls.kind, accepted: cls.accepted, verbatim: cls.verbatim });

	const loCls = await attemptCeilingSize(BRACKET_LO);
	note(BRACKET_LO, loCls);
	if (!loCls.accepted) {
		return {
			max: 0,
			firstFailure: loCls.verbatim,
			firstFailureSize: BRACKET_LO,
			attempts,
			truncated: false,
		};
	}

	const hiCls = await attemptCeilingSize(BRACKET_HI);
	note(BRACKET_HI, hiCls);
	if (hiCls.accepted) {
		return {
			max: BRACKET_HI,
			firstFailure: null,
			firstFailureSize: null,
			attempts,
			truncated: false,
			bracketExhausted: true,
		};
	}

	let lo = BRACKET_LO;
	let hi = BRACKET_HI;
	let firstFailure = hiCls.verbatim;
	let firstFailureSize = BRACKET_HI;
	let probes = 2;
	while (hi - lo > GRANULARITY && probes < MAX_SEARCH_PROBES && Date.now() < deadlineMs) {
		const mid = lo + Math.floor((hi - lo) / 2);
		const cls = await attemptCeilingSize(mid);
		note(mid, cls);
		probes++;
		if (cls.accepted) {
			lo = mid;
		} else {
			hi = mid;
			firstFailure = cls.verbatim;
			firstFailureSize = mid;
		}
	}
	return {
		max: lo,
		firstFailure,
		firstFailureSize,
		attempts,
		truncated: hi - lo > GRANULARITY,
	};
}

// ---------------------------------------------------------------------------
// Phase 2: stdin support for -p
// ---------------------------------------------------------------------------

function evalStdinRun(run) {
	const haystack = `${run.assistantText} ${typeof run.resultEvent?.result === "string" ? run.resultEvent.result : ""}`;
	const sentinelSeen = haystack.includes(STDIN_SENTINEL);
	const resultOk = !!(
		run.resultEvent &&
		run.resultEvent.subtype === "success" &&
		!run.resultEvent.is_error &&
		run.code === 0
	);
	return {
		supported: resultOk && sentinelSeen,
		sentinelSeen,
		rc: run.code,
		timedOut: run.timedOut,
		resultSubtype: run.resultEvent?.subtype ?? null,
		resultText:
			typeof run.resultEvent?.result === "string"
				? clip(run.resultEvent.result, 200)
				: null,
		assistantSample: clip(run.assistantText, 200) ?? "",
		stderrFirst: firstStderrLine(run),
	};
}

async function phaseStdin(deadlineMs) {
	const helpRun = await runCli(["--help"], { timeoutMs: HELP_TIMEOUT_MS, keepStdout: true, label: "stdin:help" });
	const helpText = helpRun.stdoutFull ?? "";
	const helpMatches = helpText
		.split("\n")
		.filter((l) => /stdin|standard input|piped|\bpipe\b/i.test(l))
		.map((l) => l.trim())
		.filter(Boolean);
	log(`stdin: --help rc=${helpRun.code}; stdin-related help lines: ${helpMatches.length}`);
	for (const m of helpMatches) log(`stdin: help match: ${clip(m, 200)}`);

	const results = {};
	if (Date.now() < deadlineMs) {
		const runA = await runCli(
			["-p", "--output-format", "stream-json", "--model", MODEL, "--trust"],
			{ stdinData: STDIN_PROMPT, timeoutMs: STDIN_TIMEOUT_MS, label: "stdin:no-prompt-arg" },
		);
		results.noPromptArg = evalStdinRun(runA);
		log(
			`stdin mode A (no prompt arg, piped stdin): rc=${runA.code} timedOut=${runA.timedOut} ` +
				`result=${results.noPromptArg.resultSubtype ?? "-"} sentinel=${results.noPromptArg.sentinelSeen}` +
				(results.noPromptArg.stderrFirst
					? ` stderr=${JSON.stringify(results.noPromptArg.stderrFirst)}`
					: ""),
		);
	}
	if (Date.now() < deadlineMs) {
		const runB = await runCli(
			["-p", "--output-format", "stream-json", "--model", MODEL, "--trust", "-"],
			{ stdinData: STDIN_PROMPT, timeoutMs: STDIN_TIMEOUT_MS, label: "stdin:dash-prompt" },
		);
		results.dashPrompt = evalStdinRun(runB);
		log(
			`stdin mode B (prompt arg "-", piped stdin): rc=${runB.code} timedOut=${runB.timedOut} ` +
				`result=${results.dashPrompt.resultSubtype ?? "-"} sentinel=${results.dashPrompt.sentinelSeen}` +
				(results.dashPrompt.resultText
					? ` resultText=${JSON.stringify(results.dashPrompt.resultText)}`
					: "") +
				(results.dashPrompt.stderrFirst
					? ` stderr=${JSON.stringify(results.dashPrompt.stderrFirst)}`
					: ""),
		);
	}

	const supported = !!(results.noPromptArg?.supported || results.dashPrompt?.supported);
	return { helpMatches, results, supported };
}

// ---------------------------------------------------------------------------
// Phase 3: long-chat behavior (resume up to 12 turns)
// ---------------------------------------------------------------------------

/**
 * Tracks the request context footprint (inputTokens + cacheReadTokens) across
 * turns and flags a collapse against the linear growth trend. Observed on
 * this CLI: usage alternates between fresh-input and cache-read accounting
 * (and one report double-counted both), so a plain turn-over-turn comparison
 * false-positives on cache noise. Expectation = median of the recent window
 * plus the median per-turn delta within it, and the collapse must persist for
 * two consecutive turns before it is reported as a signal.
 */
function makeContextTrend(windowSize = 5) {
	const totals = [];
	let dropStreak = 0;
	const median = (arr) => {
		const sorted = [...arr].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	};
	return {
		push(footprint) {
			const prev = totals.slice(-windowSize);
			let expected = null;
			if (prev.length >= 3) {
				const deltas = [];
				for (let i = 1; i < prev.length; i++) deltas.push(prev[i] - prev[i - 1]);
				if (deltas.length >= 2) expected = median(prev) + median(deltas);
			}
			totals.push(footprint);
			if (expected != null && footprint < expected * 0.75) {
				dropStreak++;
				return { expected, isDrop: true, sustained: dropStreak >= 2 };
			}
			dropStreak = 0;
			return { expected, isDrop: false, sustained: false };
		},
	};
}

async function phaseLongChat(deadlineMs) {
	const turns = [];
	let chatId = null;
	let outcome = "no-signal";
	let contextWording = null;
	let compactionSignal = null;
	const trend = makeContextTrend();
	const totalInvocations = 1 + LONG_CHAT_RESUME_TURNS;

	for (let turn = 1; turn <= totalInvocations; turn++) {
		if (Date.now() >= deadlineMs) {
			log(`longchat: wall budget reached before turn ${turn}; stopping at ${turn - 1} completed turn(s)`);
			turns.push({ turn, skipped: "wall-budget" });
			break;
		}
		const marker = `MARKER-${turn}-${randHex(4)}`;
		const prompt = buildTurnPrompt(turn, marker);
		const args =
			turn === 1
				? ["-p", "--output-format", "stream-json", "--model", MODEL, "--trust", prompt]
				: [
						"--resume",
						chatId,
						"-p",
						"--output-format",
						"stream-json",
						"--model",
						MODEL,
						"--trust",
						prompt,
					];

		let run = await runCli(args, { label: `longchat:turn${turn}` });
		let cls = classifyInvocation(run);
		if (!cls.accepted && cls.kind !== "os-e2big" && cls.kind !== "wall-budget") {
			log(`longchat turn ${turn} rejected (${cls.kind}); retrying once`);
			run = await runCli(args, { label: `longchat:turn${turn}:retry` });
			cls = classifyInvocation(run);
		}

		const sessionPreserved =
			turn > 1 ? (run.initEvent?.session_id ?? null) === chatId : null;
		const inputTokens = run.resultEvent?.usage?.inputTokens ?? null;
		const outputTokens = run.resultEvent?.usage?.outputTokens ?? null;
		const cacheReadTokens = run.resultEvent?.usage?.cacheReadTokens ?? null;
		const cacheWriteTokens = run.resultEvent?.usage?.cacheWriteTokens ?? null;
		const totalContext = totalContextOf(run);
		turns.push({
			turn,
			resumed: turn > 1,
			rc: run.code,
			kind: cls.kind,
			accepted: cls.accepted,
			sessionPreserved,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalContext,
			durationMs: run.durationMs,
			errorVerbatim: cls.verbatim,
		});
		log(
			`longchat turn=${turn}${turn > 1 ? " (resume)" : ""} rc=${run.code} kind=${cls.kind} accepted=${cls.accepted} ` +
				`sessionPreserved=${sessionPreserved ?? "-"} usage=[${usageOf(run)}] durMs=${run.durationMs}` +
				(cls.verbatim ? ` verbatim=${JSON.stringify(clip(cls.verbatim, 220))}` : ""),
		);

		if (run.compactSignalLines.length > 0 && !compactionSignal) {
			compactionSignal = run.compactSignalLines.slice(0, 5);
			log(`longchat: possible compaction signal: ${JSON.stringify(clip(compactionSignal[0], 220))}`);
		}
		// Heuristic compaction tell: the request's context footprint collapsing
		// below the linear growth trend while the transcript only grows. A single
		// anomalous usage report (e.g. input and cacheRead double-counted) must
		// not fire it; the collapse must persist for two consecutive turns.
		const footprint = totalContext ?? inputTokens;
		if (footprint != null) {
			const t = trend.push(footprint);
			if (t.isDrop) {
				log(
					`longchat: context footprint ${footprint} below 75% of trend expectation ${Math.round(t.expected)} (streak ${t.sustained ? ">=2" : "1"})`,
				);
				if (t.sustained && !compactionSignal) {
					compactionSignal = [
						`[probe] request context footprint collapsed below the growth trend for two consecutive turns while the transcript only grew (CLI-side compaction?)`,
				];
				}
			}
		}

		if (!cls.accepted) {
			outcome = "cli-errored";
			if (cls.verbatim && CONTEXT_ERROR_RE.test(cls.verbatim)) {
				contextWording = cls.verbatim;
			}
			log(`longchat: stopping at failed turn ${turn} (kind=${cls.kind})`);
			break;
		}
		if (turn === 1) {
			chatId = run.initEvent?.session_id ?? null;
			if (!chatId) {
				outcome = "cli-errored";
				log("longchat: turn 1 succeeded but system/init.session_id is missing; cannot resume");
				break;
			}
			log(`longchat: chat id ${chatId}`);
		}
	}

	if (outcome !== "cli-errored") {
		outcome = compactionSignal ? "cli-compacted" : "no-signal";
	}
	return { outcome, contextWording, compactionSignal, turns, chatId };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
	if (CLEANED) return;
	CLEANED = true;
	if (CURRENT_CHILD) {
		try {
			process.kill(-CURRENT_CHILD.pid, "SIGKILL");
		} catch {}
		CURRENT_CHILD = null;
	}
	for (const dir of [TEMP_HOME, WORKDIR]) {
		if (!dir) continue;
		try {
			rmSync(dir, { recursive: true, force: true });
			log(`cleanup: removed temp dir ${dir}`);
		} catch (err) {
			log(`cleanup: FAILED to remove temp dir ${dir}: ${err.message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Offline self-test (no CLI, no network, no keychain)
// ---------------------------------------------------------------------------

function selfTest() {
	const assert = (cond, msg) => {
		if (!cond) throw new Error(`self-test failed: ${msg}`);
	};
	for (const size of [1024, 4096, 524_288, BRACKET_HI]) {
		const p = buildCeilingPrompt(size);
		assert(Buffer.byteLength(p, "utf8") === size, `ceiling prompt must be exactly ${size}B`);
		assert(/^[\x20-\x7e\n]*$/.test(p), "ceiling prompt must be pure ASCII");
	}
	const turn1 = buildTurnPrompt(1, "MARKER-1-abcd");
	const t1len = Buffer.byteLength(turn1, "utf8");
	assert(t1len >= 1500 && t1len <= 2600, `turn prompt ~2KB (got ${t1len})`);
	assert(/compact|condens|summariz|truncat/i.test(turn1) === false, "turn filler must avoid signal words");

	// stream parsing: plain line, duration-prefixed line, garbage line
	const summary = {
		eventCounts: {},
		nonJsonLines: 0,
		nonJsonFirst: null,
		initEvent: null,
		resultEvent: null,
		errorEvent: null,
		assistantText: "",
		compactSignalLines: [],
	};
	// simulate handleLine via a fresh runCli-free helper: reuse stripDurationPrefix
	assert(stripDurationPrefix('4.097 {"type":"a"}') === '{"type":"a"}', "duration prefix stripped");
	assert(stripDurationPrefix('{"type":"a"}') === '{"type":"a"}', "plain line untouched");

	// classifier fixtures
	const okRun = { resultEvent: { subtype: "success", is_error: false }, code: 0 };
	assert(classifyInvocation(okRun).accepted === true, "success frame accepted");
	const liarRun = { resultEvent: { subtype: "error_during_execution", is_error: true, result: "boom" }, code: 0 };
	const liar = classifyInvocation(liarRun);
	assert(liar.accepted === false && liar.kind === "cli-error" && liar.verbatim === "boom", "rc=0 error frame rejected");
	const e2bigRun = { spawnError: Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" }) };
	const e2big = classifyInvocation(e2bigRun);
	assert(e2big.accepted === false && e2big.kind === "os-e2big" && /E2BIG/.test(e2big.verbatim), "E2BIG classified");
	const timeoutRun = { timedOut: true };
	assert(classifyInvocation(timeoutRun).kind === "timeout", "timeout classified");
	const noResultRun = { code: 0, eventCounts: {}, stdoutBytes: 0, stderrBytes: 0, durationMs: 250 };
	const noResult = classifyInvocation(noResultRun);
	assert(noResult.kind === "no-result" && /silent no-op/.test(noResult.verbatim), "rc0 silent no-result rejected with observed facts");

	// context trend: the observed run-2 sequence (one anomalous double-counted
	// report) must NOT fire; monotonic growth must not fire; a sustained
	// collapse must fire.
	const observed = [16308, 33704, 17380, 17903, 18426, 18949, 19472, 19994, 20497, 21000, 21503, 22006, 22511];
	let noisyFired = false;
	const noisy = makeContextTrend();
	for (const v of observed) if (noisy.push(v).sustained) noisyFired = true;
	assert(!noisyFired, "single anomalous usage report must not read as compaction");
	const linear = makeContextTrend();
	let linearFired = false;
	for (const v of [16000, 16500, 17000, 17500, 18000]) if (linear.push(v).sustained) linearFired = true;
	assert(!linearFired, "monotonic growth must not read as compaction");
	const collapse = makeContextTrend();
	let collapseFired = false;
	for (const v of [16000, 16500, 17000, 17500, 6000, 6100]) if (collapse.push(v).sustained) collapseFired = true;
	assert(collapseFired, "sustained collapse must read as compaction");
	log("self-test: OK (prompt builders, prefix stripping, classifier fixtures)");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function usage() {
	process.stderr.write(
		"usage: node prompt-ceiling-probe.mjs --out <report.json> [--cli cursor-agent] [--model composer-2.5-fast] [--self-test]\n",
	);
}

async function main() {
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") OUT_PATH = argv[++i];
		else if (argv[i] === "--cli") CLI = argv[++i];
		else if (argv[i] === "--model") MODEL = argv[++i];
		else if (argv[i] === "--self-test") {
			selfTest();
			return 0;
		} else if (argv[i] === "--help" || argv[i] === "-h") {
			usage();
			return 0;
		} else {
			usage();
			return 2;
		}
	}
	if (!OUT_PATH) {
		usage();
		return 2;
	}

	log(`probe start; cli=${CLI} model=${MODEL} out=${OUT_PATH}`);
	log(`budgets: total=${TOTAL_BUDGET_MS}ms invocationCap=${INVOCATION_TIMEOUT_MS}ms bracket=${BRACKET_LO}..${BRACKET_HI}`);

	setupTempHome();

	// Infra check: the CLI must run under the file-store HOME.
	const vres = await runCli(["--version"], {
		timeoutMs: HELP_TIMEOUT_MS,
		keepStdout: true,
		label: "version",
	});
	const versionText = (vres.stdoutFull ?? "").trim() || `rc=${vres.code}`;
	if (vres.code !== 0) {
		throw new Error(`infra: \`${CLI} --version\` failed under the file-store HOME (rc=${vres.code}): ${clip(vres.stderrText, 200)}`);
	}
	log(`cli version: ${clip(versionText, 120)}`);

	// Phase order: stdin (fast) -> ceiling (variable) -> long chat (reserved).
	const stdinDeadline = Math.min(START_MS + STDIN_PHASE_BUDGET_MS, HARD_END_MS);
	const ceilingDeadline = Math.min(
		START_MS + TOTAL_BUDGET_MS - WALL_MARGIN_MS - LONG_CHAT_RESERVE_MS,
		HARD_END_MS,
	);
	const longChatDeadline = HARD_END_MS;

	log("phase 2/3: stdin support");
	const stdinRes = await phaseStdin(stdinDeadline);
	log(`phase 2/3 result: stdinSupported=${stdinRes.supported}`);

	log("phase 1/3: prompt ceiling");
	const ceilingRes = await phaseCeiling(ceilingDeadline);
	log(
		`phase 1/3 result: maxAcceptedPromptBytes=${ceilingRes.max}` +
			` (truncated=${ceilingRes.truncated}${ceilingRes.bracketExhausted ? ", bracket exhausted at 1MB with no failure" : ""})`,
	);

	log("phase 3/3: long chat");
	const longRes = await phaseLongChat(longChatDeadline);
	log(
		`phase 3/3 result: longChatOutcome=${longRes.outcome} contextErrorWording=${JSON.stringify(clip(longRes.contextWording, 200))} turns=${longRes.turns.filter((t) => !t.skipped).length}`,
	);

	const report = {
		maxAcceptedPromptBytes: ceilingRes.max,
		firstFailureError: ceilingRes.firstFailure,
		stdinSupported: stdinRes.supported,
		longChatOutcome: longRes.outcome,
		contextErrorWording: longRes.contextWording,
	};
	mkdirSync(dirname(OUT_PATH) || ".", { recursive: true });
	writeFileSync(OUT_PATH, `${JSON.stringify(report, null, "\t")}\n`);
	log(`report written to ${OUT_PATH}`);
	log(`report: ${JSON.stringify(report)}`);
	return 0;
}

process.on("SIGINT", () => {
	log("interrupted; killing child and cleaning up");
	cleanup();
	process.exit(130);
});
process.on("SIGTERM", () => {
	log("terminated; killing child and cleaning up");
	cleanup();
	process.exit(143);
});

try {
	const rc = await main();
	cleanup();
	process.exit(rc);
} catch (err) {
	process.stderr.write(`[+${elapsedS()}s] probe infra failure: ${err?.stack ?? err}\n`);
	cleanup();
	process.exit(1);
}
