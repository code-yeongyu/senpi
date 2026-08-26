#!/usr/bin/env node
/**
 * Real-CLI QA scenario for the cursor-cli-oauth lane (todo 24).
 *
 * Drives the REAL cursor-agent binary end to end, gated behind
 * SENPI_CURSOR_CLI_LIVE=1 so it never runs in CI defaults. Auth is
 * file-store only: the login keychain is read ONCE into memory (the Wave-0
 * probe extraction pattern) and written as 0600 `.cursor/auth.json` inside a
 * per-case sandbox HOME (0700 `.cursor`), with AGENT_CLI_CREDENTIAL_STORE=file.
 * Token values never appear in any log, receipt, or summary - only byte
 * lengths. The user's real agent auth.json is hashed before the first CLI
 * call and verified unchanged after every case and at exit (guardRealAuth).
 *
 * Four cases, each writing a JSONL receipt plus a PASS/FAIL line:
 *   1. STREAMING SPREAD  - gpt-5.5-low turn writing ~12 lines; assistant
 *      deltas must arrive spread over >1s (not one clump).
 *   2. TOOL WITH FORCE   - a --force turn running `echo qa-force-<uuid>`;
 *      the sentinel must appear in the real tool_call result.success.stdout.
 *   3. MODEL-SWITCH RESUME - plant a neutral reference code in message 1,
 *      switch model on the SAME chat id, ask for it back; PASS requires the
 *      same session_id plus the reference code returned verbatim.
 *   4. MISSING EXECUTABLE - the senpi CLI in the same hermetic sandbox but
 *      with PATH stripped of cursor-agent and no versions dir reachable must
 *      surface the install guidance verbatim (`curl https://cursor.com/install`).
 *
 * Usage:
 *   SENPI_CURSOR_CLI_LIVE=1 node .agents/skills/senpi-qa/scripts/scenarios/cursor-cli-oauth-qa.mjs \
 *     --evidence-dir local-ignore/qa-evidence/cursor-cli-oauth
 *
 * Options:
 *   --evidence-dir <path>  receipt destination (default local-ignore/qa-evidence/cursor-cli-oauth;
 *                          relative paths resolve against the repo root)
 *   --timeout-ms <n>       per-attempt deadline for cursor-agent turns (default 300000)
 *   --executable <path>    cursor-agent executable override
 *
 * Exit codes: 0 = 4/4 PASS and the auth guard unchanged; 1 = any case failed
 * or the auth guard tripped; 2 = usage/environment error. Each network-shaped
 * turn is retried exactly once on transient failure before being is recorded.
 *
 * Node builtins + the senpi-qa harness only; no runtime npm dependency. The
 * macOS login keychain must be unlocked (this script never unlocks anything).
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, runCli } from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";

const LIVE_ENV = "SENPI_CURSOR_CLI_LIVE";
const VERSION_FLOOR = "2026.08.11";
const KEYCHAIN_LOCKED = "Error: Your macOS login keychain is locked.";
const INSTALL_GUIDANCE = "curl https://cursor.com/install";
const MISSING_BINARY_MARKER = "cursor-agent not installed";
const STREAM_MODEL = "gpt-5.5-low"; // non-fast: probe-proven 188 deltas / 4.48s spread (run F)
const TOOL_MODEL = "composer-2.5-fast";
const RESUME_INITIAL_MODEL = "composer-2.5-fast";
const RESUME_SWITCH_MODEL = "gpt-5.6-luna-high";
const MISSING_EXEC_SENPI_MODEL = "gpt-5.5-high"; // static fallback catalog id
const SPREAD_MIN_MS = 1000;
const SPREAD_MIN_ASSISTANT_EVENTS = 8;
const EXCERPT_LIMIT = 400;
const RECEIPT_EVENT_LIMIT = 600;

// PATH for case 4: enough for the senpi CLI (spawned via absolute node/tsx
// paths) but provably unable to resolve cursor-agent.
const SAFE_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"];

/** Every spawned child, tracked for process-group shutdown and reap proof. */
const spawned = [];
const sandboxDirs = [];

function trackChild(child, label) {
	spawned.push({ label, pid: child.pid, child, exitCode: null, signal: null, reaped: false });
	return child;
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

function digest16(hash) {
	return typeof hash === "string" ? `${hash.slice(0, 16)}…` : String(hash);
}

function sha256OrNull(path) {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null; // absent file is a valid state
	}
}

/** Write one JSONL receipt file under the evidence dir. */
function writeReceipt(evidenceDir, name, records) {
	writeFileSync(join(evidenceDir, name), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// cursor-agent executable + keychain extraction (Wave-0 probe patterns)
// ---------------------------------------------------------------------------

function isCandidatePath(candidate) {
	try {
		const stat = lstatSync(candidate);
		return stat.isFile() || stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function resolveCursorAgentExecutable(explicit) {
	if (explicit) {
		if (existsSync(explicit)) return explicit;
		throw new Error(`--executable path does not exist: ${explicit}`);
	}
	const candidates = [];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir) candidates.push(join(dir, "cursor-agent"));
	}
	candidates.push(join(homedir(), ".local", "bin", "cursor-agent"));
	const versionsRoot = join(homedir(), ".local", "share", "cursor-agent", "versions");
	try {
		for (const version of readdirSync(versionsRoot)) {
			candidates.push(join(versionsRoot, version, "cursor-agent"));
		}
	} catch {
		/* no versions dir */
	}
	for (const candidate of candidates) {
		if (isCandidatePath(candidate)) return candidate;
	}
	throw new Error(
		"cursor-agent executable not found on PATH, ~/.local/bin, or ~/.local/share/cursor-agent/versions/*",
	);
}

/** Keychain credential read; values never leave memory / the sandbox auth.json. */
function readKeychainToken(service) {
	const res = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 64 * 1024,
	});
	if (res.error || res.status !== 0) {
		if ((res.stderr ?? "").includes(KEYCHAIN_LOCKED)) {
			throw new Error(
				`${KEYCHAIN_LOCKED} (unlock the login keychain and re-run; this script never unlocks anything)`,
			);
		}
		throw new Error(
			`keychain read failed for ${service} (status=${res.status}, stderr=${excerpt((res.stderr ?? "").trim(), 200)})`,
		);
	}
	const token = (res.stdout ?? "").replace(/\r?\n$/, "");
	if (!token) throw new Error(`keychain returned an empty token for ${service}`);
	return token;
}

/** Sandbox HOME holding the 0600 file-store auth.json (0700 .cursor dir). */
function makeCursorHome(sandboxDir, accessToken, refreshToken) {
	const home = join(sandboxDir, "cli-home");
	const cursorDir = join(home, ".cursor");
	const tmpDir = join(sandboxDir, "cli-tmp");
	mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
	mkdirSync(tmpDir, { recursive: true, mode: 0o755 });
	// The file-store contract proven 2026-08-17: 0600 file inside 0700 dir.
	writeFileSync(
		join(cursorDir, "auth.json"),
		JSON.stringify({ accessToken, refreshToken, apiKey: null, bedrockCredentials: null }),
		{ mode: 0o600 },
	);
	return { home, tmpDir };
}

/** Strict child-env allowlist; auth-bearing env is deliberately absent. */
function cursorAgentEnv(home, tmpDir) {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: tmpDir,
		TERM: "dumb",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
		FORCE_COLOR: "0",
		AGENT_CLI_CREDENTIAL_STORE: "file",
	};
}

// ---------------------------------------------------------------------------
// cursor-agent turn runner (streaming, process-group discipline)
// ---------------------------------------------------------------------------

/**
 * Run one cursor-agent -p turn. Each parsed stdout line is handed to
 * onEvent(obj, arrivalMs) live, so callers record true arrival timestamps.
 * Resolves with { rc, signal, timedOut, spawnError, stderr, events, wallMs }
 * where events is [{ arrivalMs, obj }].
 */
function runCursorAgent({ executable, cwd, env, args, timeoutMs, onEvent }) {
	return new Promise((resolveRun) => {
		const startedAt = Date.now();
		let child;
		try {
			// detached: own process group so timeouts kill the whole tree.
			child = spawn(executable, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolveRun({ rc: null, signal: null, timedOut: false, spawnError: String(error), stderr: "", events: [] });
			return;
		}
		trackChild(child, `cursor-agent${args.includes("--force") ? " --force" : ""}`);
		let stdoutBuffer = "";
		let stderr = "";
		let timedOut = false;
		const events = [];
		const drain = (chunk) => {
			stdoutBuffer += chunk;
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";
			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line) continue;
				const jsonStart = line.indexOf("{");
				if (jsonStart < 0) continue;
				let obj;
				try {
					obj = JSON.parse(line.slice(jsonStart));
				} catch {
					continue;
				}
				const arrivalMs = Date.now();
				events.push({ arrivalMs, obj });
				if (onEvent) onEvent(obj, arrivalMs);
			}
		};
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
		child.stdout.on("data", drain);
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveRun({
				rc: null,
				signal: null,
				timedOut: false,
				spawnError: error.message,
				stderr,
				events,
				wallMs: Date.now() - startedAt,
			});
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveRun({ rc: code, signal, timedOut, spawnError: null, stderr, events, wallMs: Date.now() - startedAt });
		});
	});
}

function streamArgs({ prompt, model, force, resumeChatId }) {
	return [
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--stream-partial-output",
		"--model",
		model,
		"--trust",
		...(resumeChatId ? ["--resume", resumeChatId] : []),
		...(force ? ["--force"] : []),
	];
}

function findEvent(events, predicate) {
	for (const { obj } of events) {
		if (predicate(obj)) return obj;
	}
	return null;
}

function initEvent(attempt) {
	return findEvent(attempt.events, (o) => o.type === "system" && o.subtype === "init");
}

/**
 * The completed tool_call result has been observed in two shapes on the real
 * CLI: tool_call.result.success (probe run-d, 2026-08-17) and
 * tool_call.shellToolCall.result.success (current build). Accept both.
 */
function toolCallSuccess(obj) {
	const direct = obj.tool_call?.result?.success;
	if (direct && typeof direct === "object") return { success: direct, path: "tool_call.result.success" };
	const nested = obj.tool_call?.shellToolCall?.result?.success;
	if (nested && typeof nested === "object") {
		return { success: nested, path: "tool_call.shellToolCall.result.success" };
	}
	return null;
}

function resultEvent(attempt) {
	return findEvent(attempt.events, (o) => o.type === "result");
}

function attemptSummary(attempt) {
	const result = resultEvent(attempt);
	return {
		spawnError: attempt.spawnError,
		rc: attempt.spawnError ? null : attempt.rc,
		signal: attempt.signal,
		timedOut: attempt.timedOut,
		wallMs: attempt.wallMs ?? null,
		parsedEvents: attempt.events.length,
		hasResultEvent: result != null,
		resultIsError: result?.is_error === true,
		cliDurationMs: typeof result?.duration_ms === "number" ? result.duration_ms : null,
		resultExcerpt: typeof result?.result === "string" ? excerpt(result.result) : null,
		stderrExcerpt: attempt.stderr?.trim() ? excerpt(attempt.stderr.trim()) : null,
	};
}

/** Transient = the CLI itself failed (rc/stream/is_error/spawn/timeout). */
function isTransientFailure(summary) {
	return (
		summary.spawnError !== null ||
		summary.timedOut ||
		summary.rc !== 0 ||
		!summary.hasResultEvent ||
		summary.resultIsError ||
		summary.parsedEvents === 0
	);
}

/** One turn with a single retry on transient failure. Receipts the attempts. */
async function runTurnWithRetry(config, label, receipts) {
	const attempts = [];
	let attempt = null;
	for (let i = 0; i < 2; i++) {
		attempt = await runCursorAgent(config);
		const summary = attemptSummary(attempt);
		attempts.push(summary);
		if (attempt.stderr?.includes(KEYCHAIN_LOCKED)) {
			throw new Error(`${KEYCHAIN_LOCKED} (environmental lock during ${label})`);
		}
		if (!isTransientFailure(summary)) break;
		process.stdout.write(
			`[retry] ${label}: transient failure (rc=${summary.rc ?? "spawn-error"}, timedOut=${summary.timedOut}, ` +
				`hasResult=${summary.hasResultEvent}, is_error=${summary.resultIsError}); ${i === 0 ? "retrying once" : "recording failure"}\n`,
		);
	}
	receipts.push({ record: "turn-attempts", label, attempts });
	return attempt;
}

function newCaseSandbox(caseLabel, accessToken, refreshToken) {
	const box = makeSandbox(`senpi-qa-ccli-${caseLabel}`);
	sandboxDirs.push(box.dir);
	const { home, tmpDir } = makeCursorHome(box.dir, accessToken, refreshToken);
	return { box, home, tmpDir, env: cursorAgentEnv(home, tmpDir), cleanup: () => box.cleanup() };
}

// ---------------------------------------------------------------------------
// Case 1: streaming spread
// ---------------------------------------------------------------------------

async function caseStreamingSpread({ executable, accessToken, refreshToken, timeoutMs, evidenceDir }) {
	const receipts = [{ record: "case", id: 1, name: "streaming-spread", model: STREAM_MODEL }];
	const sandbox = newCaseSandbox("case1", accessToken, refreshToken);
	try {
		const prompt =
			"Write exactly 12 numbered lines, each a distinct 10-word fact about rivers. " +
			"Take your time and write them one by one. Do not use any tools.";
		const eventLog = [];
		const collect = { onEvent: (obj, arrivalMs) => {
			if (eventLog.length >= RECEIPT_EVENT_LIMIT) return;
			const block = obj.message?.content?.[0];
			eventLog.push({
				record: "event-arrival",
				type: obj.type,
				subtype: obj.subtype ?? null,
				arrivalMs,
				chars:
					typeof obj.text === "string"
						? obj.text.length
						: typeof block?.text === "string"
							? block.text.length
							: null,
			});
		} };
		const turnConfig = {
			executable,
			cwd: sandbox.box.cwd,
			env: sandbox.env,
			args: streamArgs({ prompt, model: STREAM_MODEL }),
			timeoutMs,
		};
		let attempt = await runTurnWithRetry({ ...turnConfig, ...collect }, "case-1 streaming-spread", receipts);
		let summary = attemptSummary(attempt);
		let assistantArrivals = () =>
			eventLog
				.filter((e) => e.type === "assistant")
				.map((e) => e.arrivalMs)
				.sort((a, b) => a - b);
		let arrivals = assistantArrivals();
		let spanMs = arrivals.length >= 2 ? arrivals.at(-1) - arrivals[0] : 0;
		// A healthy stream that arrived as one clump is exactly the transient
		// network artifact this case exists to catch: retry once, record both.
		if (!isTransientFailure(summary) && (spanMs <= SPREAD_MIN_MS || arrivals.length < SPREAD_MIN_ASSISTANT_EVENTS)) {
			process.stdout.write(
				`[retry] case-1 streaming-spread: healthy stream arrived clumped ` +
					`(${arrivals.length} deltas over ${spanMs} ms); retrying once\n`,
			);
			eventLog.length = 0;
			attempt = await runTurnWithRetry({ ...turnConfig, ...collect }, "case-1 streaming-spread (clump retry)", receipts);
			summary = attemptSummary(attempt);
			arrivals = assistantArrivals();
			spanMs = arrivals.length >= 2 ? arrivals.at(-1) - arrivals[0] : 0;
		}
		const streamHealthy = !isTransientFailure(summary) && summary.resultExcerpt !== null;
		const pass = streamHealthy && arrivals.length >= SPREAD_MIN_ASSISTANT_EVENTS && spanMs > SPREAD_MIN_MS;
		const detail =
			`${arrivals.length} assistant deltas over ${spanMs} ms ` +
			`(threshold: >= ${SPREAD_MIN_ASSISTANT_EVENTS} events, span > ${SPREAD_MIN_MS} ms)`;
		receipts.push({
			record: "case-verdict",
			id: 1,
			pass,
			detail,
			assistantEventCount: arrivals.length,
			spanMs,
			firstAssistantArrival: arrivals[0] ?? null,
			lastAssistantArrival: arrivals.at(-1) ?? null,
			spreadOverOneSecond: spanMs > SPREAD_MIN_MS,
			resultOk: streamHealthy,
		});
		writeReceipt(evidenceDir, "case-1-streaming-spread.jsonl", receipts);
		return { pass, detail };
	} finally {
		sandbox.cleanup();
	}
}

// ---------------------------------------------------------------------------
// Case 2: tool with force
// ---------------------------------------------------------------------------

async function caseToolWithForce({ executable, accessToken, refreshToken, timeoutMs, evidenceDir }) {
	const sentinel = `qa-force-${randomUUID()}`;
	const receipts = [{ record: "case", id: 2, name: "tool-with-force", model: TOOL_MODEL, sentinel }];
	const sandbox = newCaseSandbox("case2", accessToken, refreshToken);
	try {
		const prompt = `Run the shell command \`echo ${sentinel}\` and tell me its exact stdout.`;
		const completedToolCalls = [];
		const attempt = await runTurnWithRetry(
			{
				executable,
				cwd: sandbox.box.cwd,
				env: sandbox.env,
				args: streamArgs({ prompt, model: TOOL_MODEL, force: true }),
				timeoutMs,
				onEvent: (obj) => {
					if (obj.type === "tool_call" && obj.subtype === "completed") {
						const found = toolCallSuccess(obj);
						const stdoutText = typeof found?.success?.stdout === "string" ? found.success.stdout : null;
						completedToolCalls.push({ stdoutText, resultPath: found?.path ?? null });
						receipts.push({
							record: "tool-call-completed",
							call_id: obj.call_id ?? null,
							resultPath: found?.path ?? null,
							command:
								found?.success?.command ?? obj.tool_call?.shellToolCall?.args?.command ?? null,
							exitCode: found?.success?.exitCode ?? null,
							stdoutExcerpt: stdoutText === null ? null : excerpt(stdoutText, 200),
						});
					}
				},
			},
			"case-2 tool-with-force",
			receipts,
		);
		const summary = attemptSummary(attempt);
		const init = initEvent(attempt);
		const sentinelInStdout = completedToolCalls.some((call) => call.stdoutText?.includes(sentinel) === true);
		const pass = sentinelInStdout && !isTransientFailure(summary) && init?.apiKeySource === "login";
		const detail =
			`sentinel in tool_call result.success.stdout: ${sentinelInStdout}; ` +
			`apiKeySource=${init?.apiKeySource ?? "unknown"}; rc=${summary.rc}`;
		receipts.push({
			record: "case-verdict",
			id: 2,
			pass,
			detail,
			sentinel,
			sentinelInToolStdout: sentinelInStdout,
			resultPaths: [...new Set(completedToolCalls.map((c) => c.resultPath).filter(Boolean))],
			apiKeySource: init?.apiKeySource ?? null,
			toolCallCompletedCount: completedToolCalls.length,
		});
		writeReceipt(evidenceDir, "case-2-tool-with-force.jsonl", receipts);
		return { pass, detail };
	} finally {
		sandbox.cleanup();
	}
}

// ---------------------------------------------------------------------------
// Case 3: model-switch resume
// ---------------------------------------------------------------------------

async function caseModelSwitchResume({ executable, accessToken, refreshToken, timeoutMs, evidenceDir }) {
	// Neutral wording only: "reference code", never "secret" (probe-proven
	// refusal class when secrecy-primed).
	const referenceCode = `REF-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
	const receipts = [
		{
			record: "case",
			id: 3,
			name: "model-switch-resume",
			initialModel: RESUME_INITIAL_MODEL,
			switchModel: RESUME_SWITCH_MODEL,
			referenceCode,
		},
	];
	const sandbox = newCaseSandbox("case3", accessToken, refreshToken);
	try {
		const plantPrompt =
			"This is a context-fidelity check across model switches.\n" +
			`My reference code for this conversation is \`${referenceCode}\`.\n` +
			"Keep this exact reference code in conversation memory. Do not write it to disk.\n" +
			"Reply with exactly: REFERENCE STORED";
		const recallPrompt =
			"Reply with the reference code from my FIRST message in this conversation, " +
			"verbatim and complete, and nothing else. Do not use any tools.";

		const plant = await runTurnWithRetry(
			{
				executable,
				cwd: sandbox.box.cwd,
				env: sandbox.env,
				args: streamArgs({ prompt: plantPrompt, model: RESUME_INITIAL_MODEL }),
				timeoutMs,
			},
			"case-3 plant",
			receipts,
		);
		const plantSummary = attemptSummary(plant);
		const plantInit = initEvent(plant);
		const chatId = plantInit?.session_id ?? null;
		if (isTransientFailure(plantSummary) || !chatId) {
			const detail = `plant turn failed to establish a chat (rc=${plantSummary.rc}, timedOut=${plantSummary.timedOut})`;
			receipts.push({ record: "case-verdict", id: 3, pass: false, detail, referenceCode });
			writeReceipt(evidenceDir, "case-3-model-switch-resume.jsonl", receipts);
			return { pass: false, detail };
		}
		receipts.push({
			record: "plant",
			chatId,
			apiKeySource: plantInit?.apiKeySource ?? null,
			initModel: plantInit?.model ?? null,
		});

		const recall = await runTurnWithRetry(
			{
				executable,
				cwd: sandbox.box.cwd,
				env: sandbox.env,
				args: streamArgs({ prompt: recallPrompt, model: RESUME_SWITCH_MODEL, resumeChatId: chatId }),
				timeoutMs,
			},
			"case-3 recall",
			receipts,
		);
		const recallSummary = attemptSummary(recall);
		const recallInit = initEvent(recall);
		const recallSessionId = recallInit?.session_id ?? null;
		const resultText = typeof resultEvent(recall)?.result === "string" ? resultEvent(recall).result : "";
		const sameSession = recallSessionId === chatId;
		const referenceReturned = resultText.includes(referenceCode);
		const pass = !isTransientFailure(recallSummary) && sameSession && referenceReturned;
		const detail =
			`chat ${chatId}: resumed session_id ${recallSessionId} (same=${sameSession}); ` +
			`reference code returned=${referenceReturned}; switch model init=${recallInit?.model ?? "unknown"}`;
		receipts.push(
			{
				record: "recall",
				requestedModel: RESUME_SWITCH_MODEL,
				initModel: recallInit?.model ?? null,
				chatId,
				resumedSessionId: recallSessionId,
				sameSessionId: sameSession,
				referenceCodeReturned: referenceReturned,
				resultExcerpt: excerpt(resultText),
			},
			{ record: "case-verdict", id: 3, pass, detail, referenceCode, sameSessionId: sameSession, referenceReturned },
		);
		writeReceipt(evidenceDir, "case-3-model-switch-resume.jsonl", receipts);
		return { pass, detail };
	} finally {
		sandbox.cleanup();
	}
}

// ---------------------------------------------------------------------------
// Case 4: missing executable (senpi CLI end to end)
// ---------------------------------------------------------------------------

async function caseMissingExecutable({ evidenceDir }) {
	const receipts = [{ record: "case", id: 4, name: "missing-executable", model: MISSING_EXEC_SENPI_MODEL }];
	const box = makeSandbox("senpi-qa-ccli-case4");
	sandboxDirs.push(box.dir);
	try {
		// Enable the lane + acknowledge unattended execution so the turn path
		// reaches executable resolution (dummy tokens never spawn anything).
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify(
				{ cursorCliOauthProvider: { enabled: true, noApprovalAcknowledgedAt: new Date().toISOString() } },
				null,
				2,
			),
		);
		writeFileSync(
			join(box.agentDir, "auth.json"),
			JSON.stringify({
				"cursor-cli-oauth": {
					type: "oauth",
					access: "cursor-cli-oauth-managed",
					refresh: "cursor-cli-oauth-managed",
					expires: 4_102_448_000_000,
					accounts: [
						{
							name: "default",
							access: "qa-dummy-access",
							refresh: "qa-dummy-refresh",
							expires: Date.now() + 3_600_000,
							source: "import",
						},
					],
				},
			}),
			{ mode: 0o600 },
		);

		const safePath = [...new Set(SAFE_PATH_DIRS)].filter((dir) => existsSync(dir)).join(delimiter);
		const pathHasCursorAgent = safePath.split(delimiter).some((dir) => existsSync(join(dir, "cursor-agent")));
		const versionsReachable = existsSync(join(box.dir, ".local", "share", "cursor-agent", "versions"));
		if (pathHasCursorAgent || versionsReachable) {
			throw new Error("case-4 preflight failed: cursor-agent still resolvable in the stripped environment");
		}
		const env = { ...hermeticEnv(box.env), PATH: safePath };
		delete env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE;
		delete env.CURSOR_AGENT_EXECUTABLE;
		delete env.CURSOR_API_KEY;
		delete env.CURSOR_AUTH_TOKEN;

		const result = await runCli(
			[
				"--provider",
				"cursor-cli-oauth",
				"--model",
				MISSING_EXEC_SENPI_MODEL,
				"--print",
				"Reply with the single word ready.",
			],
			{ env, cwd: box.cwd, timeoutMs: 120_000 },
		);
		const combined = `${result.stdout}\n${result.stderr}`;
		const guidancePresent = combined.includes(INSTALL_GUIDANCE);
		const markerPresent = combined.includes(MISSING_BINARY_MARKER);
		const pass = !result.timedOut && result.code !== 0 && result.code !== null && guidancePresent && markerPresent;
		for (const line of result.stderr.split("\n").filter(Boolean).slice(0, 40)) {
			receipts.push({ record: "stderr-line", line: excerpt(line, 300) });
		}
		receipts.push({
			record: "case-verdict",
			id: 4,
			pass,
			detail: `exit=${result.code}, install guidance present=${guidancePresent}, marker present=${markerPresent}`,
			exitCode: result.code,
			timedOut: result.timedOut,
			installGuidanceVerbatim: guidancePresent,
			missingBinaryMarker: markerPresent,
			pathStrippedOfCursorAgent: !pathHasCursorAgent,
			versionsDirReachable: versionsReachable,
		});
		writeReceipt(evidenceDir, "case-4-missing-executable.jsonl", receipts);
		return { pass, detail: `exit=${result.code}, install guidance verbatim: ${guidancePresent}` };
	} finally {
		box.cleanup();
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const parsed = { evidenceDir: join("local-ignore", "qa-evidence", "cursor-cli-oauth"), timeoutMs: 300_000 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
			return argv[++i];
		};
		if (arg === "--evidence-dir") parsed.evidenceDir = next();
		else if (arg === "--timeout-ms") {
			parsed.timeoutMs = Number.parseInt(next(), 10);
			if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 1000) {
				throw new Error(`--timeout-ms must be >= 1000, got ${parsed.timeoutMs}`);
			}
		} else if (arg === "--executable") parsed.executable = next();
		else throw new Error(`unknown argument: ${arg}`);
	}
	return parsed;
}

async function main() {
	if (process.env[LIVE_ENV] !== "1") {
		process.stdout.write(
			`skip: ${LIVE_ENV}=1 not set - the cursor-cli-oauth QA scenario drives the real CLI and is opt-in only\n`,
		);
		return 0;
	}
	const config = parseArgs(process.argv.slice(2));
	const evidenceDir = resolve(repoRoot(), config.evidenceDir);
	mkdirSync(evidenceDir, { recursive: true });
	installCleanupHooks();

	// Credential integrity: snapshot BEFORE any CLI call; verify after each
	// case and at exit. The scenario never reads or writes this file itself.
	const guard = guardRealAuth();
	const authRecord = { path: guard.path, sha256Before: digest16(guard.before) };
	let authUnchanged = true;

	const executable = resolveCursorAgentExecutable(config.executable);
	const versionProbe = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
	if (versionProbe.error) throw new Error(`cannot execute ${executable}: ${versionProbe.error.message}`);
	if ((versionProbe.stderr ?? "").includes(KEYCHAIN_LOCKED)) throw new Error(KEYCHAIN_LOCKED);
	const cliVersion = (versionProbe.stdout ?? "").trim();
	if (cliVersion.slice(0, VERSION_FLOOR.length) < VERSION_FLOOR) {
		process.stdout.write(
			`[warn] cursor-agent ${cliVersion || "(unknown)"} is below the known-good floor ${VERSION_FLOOR}\n`,
		);
	}

	// Keychain extraction: tokens live only in memory and the sandbox auth.json.
	const accessToken = readKeychainToken("cursor-access-token");
	const refreshToken = readKeychainToken("cursor-refresh-token");
	process.stdout.write(
		`[setup] cursor-agent ${cliVersion} at ${executable}; file-store auth prepared ` +
			`(access ${accessToken.length}B, refresh ${refreshToken.length}B; values never logged)\n`,
	);

	const caseInput = { executable, accessToken, refreshToken, timeoutMs: config.timeoutMs, evidenceDir };
	const results = [];
	const cases = [
		[1, "streaming-spread", () => caseStreamingSpread(caseInput)],
		[2, "tool-with-force", () => caseToolWithForce(caseInput)],
		[3, "model-switch-resume", () => caseModelSwitchResume(caseInput)],
		[4, "missing-executable", () => caseMissingExecutable({ evidenceDir })],
	];
	for (const [id, name, run] of cases) {
		try {
			const outcome = await run();
			results.push({ id, name, pass: outcome.pass, detail: outcome.detail });
		} catch (error) {
			results.push({
				id,
				name,
				pass: false,
				detail: `case error: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		try {
			guard.assertUnchanged();
		} catch (error) {
			authUnchanged = false;
			results.push({ id, name: "auth-guard", pass: false, detail: String(error instanceof Error ? error.message : error) });
		}
	}

	try {
		guard.assertUnchanged();
		authRecord.sha256After = digest16(sha256OrNull(guard.path));
	} catch (error) {
		authUnchanged = false;
		authRecord.sha256After = digest16(sha256OrNull(guard.path));
		authRecord.failure = error instanceof Error ? error.message : String(error);
	}
	authRecord.unchanged = authUnchanged;

	// Cleanup receipts: every tracked child reaped, every sandbox removed.
	for (const entry of spawned) {
		entry.exitCode = entry.child.exitCode;
		entry.signal = entry.child.signalCode;
		entry.reaped = entry.child.exitCode !== null || entry.child.signalCode !== null || entry.child.killed;
	}
	const sandboxesRemoved = sandboxDirs.map((dir) => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* removal verdict comes from the existence check below */
		}
		return { dir, removed: !existsSync(dir) };
	});

	const passed = results.filter((r) => r.pass).length;
	for (const r of results) {
		process.stdout.write(`[${r.pass ? "PASS" : "FAIL"}] case-${r.id} ${r.name} — ${r.detail}\n`);
	}
	process.stdout.write(
		`auth guard: ${authUnchanged ? "UNCHANGED" : "CHANGED"} (${authRecord.path}; ` +
			`${authRecord.sha256Before} -> ${authRecord.sha256After}${authRecord.failure ? `; ${authRecord.failure}` : ""})\n`,
	);
	process.stdout.write(
		`cleanup: ${sandboxesRemoved.every((s) => s.removed) ? "all" : "SOME"} sandbox HOMEs removed; ` +
			`${spawned.filter((e) => e.reaped).length}/${spawned.length} spawned children reaped\n`,
	);
	process.stdout.write(`${passed}/4 PASS\n`);

	writeFileSync(
		join(evidenceDir, "summary.json"),
		`${JSON.stringify(
			{
				scenario: "cursor-cli-oauth-qa",
				generatedAt: new Date().toISOString(),
				executable,
				cliVersion,
				versionFloor: VERSION_FLOOR,
				liveGate: `${LIVE_ENV}=1`,
				results,
				authGuard: authRecord,
				tokenByteLengths: { access: accessToken.length, refresh: refreshToken.length },
				spawnedChildren: spawned.map((e) => ({
					label: e.label,
					pid: e.pid,
					exitCode: e.exitCode,
					signal: e.signal,
					reaped: e.reaped,
				})),
				sandboxes: sandboxesRemoved,
			},
			null,
			2,
		)}\n`,
	);
	return passed === 4 && authUnchanged ? 0 : 1;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`scenario failure: ${error?.stack ?? error}\n`);
		process.exitCode = 1;
	});
