#!/usr/bin/env node
/**
 * Probe: cursor-agent permission config schema and `--sandbox` semantics.
 *
 * Determines, empirically, against the locally installed cursor-agent CLI:
 *  (a) DENY-LIST - whether a sandbox-HOME `$HOME/.cursor/cli-config.json` can
 *      express a DENY rule that blocks a shell command while `--force` is
 *      active. Only the harmless command `echo blocked-probe` is ever used.
 *  (b) SANDBOX - which `--sandbox <mode>` values the CLI accepts (from the
 *      CLI's own error output) and the observable effect of an accepted mode
 *      on the same echo probe.
 *
 * Auth for probe runs: tokens are read ONLY via the macOS keychain CLI
 * (`security find-generic-password -s cursor-access-token -w` / `-s
 * cursor-refresh-token -w`) and written as
 * `<tempHome>/.cursor/auth.json` (mode 0600 inside a 0700 dir) with
 * AGENT_CLI_CREDENTIAL_STORE=file. Token values are never printed, logged, or
 * written anywhere outside the temp auth.json; only byte lengths are reported.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/probes/cursor-cli/permissions-config-probe.mjs \
 *     --out <report.json> [--timeout-ms 120000] [--cli <path-to-cursor-agent>]
 *
 * Exit 0 when the probe completed (regardless of the deny verdict); non-zero
 * only on infra failure (CLI missing, keychain unreadable, control run not
 * executing the command, unwritable --out path).
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SENTINEL = "blocked-probe";
const PROBE_PROMPT = "Run the shell command `echo blocked-probe` and show stdout";
const MODEL = "composer-2.5-fast";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = { out: null, timeoutMs: DEFAULT_TIMEOUT_MS, cli: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--out") out.out = argv[++i];
		else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
		else if (a === "--cli") out.cli = argv[++i];
		else {
			process.stderr.write(`unknown argument: ${a}\n`);
			process.exit(2);
		}
	}
	if (!out.out) {
		process.stderr.write("--out <path> is required\n");
		process.exit(2);
	}
	if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 5000) {
		process.stderr.write("--timeout-ms must be a number >= 5000\n");
		process.exit(2);
	}
	return out;
}

const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// infra failure helper
// ---------------------------------------------------------------------------

class InfraError extends Error {}

function infra(message) {
	return new InfraError(message);
}

// ---------------------------------------------------------------------------
// temp-home management (sandbox HOME per run; all removed on exit)
// ---------------------------------------------------------------------------

const tempRoots = [];

let tempRootsCreated = 0;

async function makeTempRoot(label) {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), `cursor-perms-probe-${label}-`));
	tempRoots.push(root);
	tempRootsCreated++;
	return root;
}

async function cleanupTempRoots() {
	const removed = [];
	for (const root of tempRoots.splice(0)) {
		try {
			await fsp.rm(root, { recursive: true, force: true });
			removed.push(root);
		} catch (err) {
			removed.push(`${root} (FAILED: ${err.message})`);
		}
	}
	return removed;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		void cleanupTempRoots().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
	});
}

/**
 * Creates a fresh sandbox HOME for one probe run.
 * Returns { root, home, configDir, ws, writeConfig, writePermissionsJson, snapshotCursorDir }.
 * auth.json (mode 0600) is written inside `.cursor` (mode 0700) immediately.
 */
async function makeSandboxHome(label, accessToken, refreshToken) {
	const root = await makeTempRoot(label);
	const home = path.join(root, "home");
	const configDir = path.join(home, ".cursor");
	const ws = path.join(root, "ws");
	await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
	await fsp.mkdir(ws, { recursive: true, mode: 0o755 });
	// Mode 0600 file, 0700 dir - the file-store contract proven 2026-08-17.
	await fsp.writeFile(
		path.join(configDir, "auth.json"),
		JSON.stringify({
			accessToken,
			refreshToken,
			apiKey: null,
			bedrockCredentials: null,
		}),
		{ mode: 0o600 },
	);
	const writeConfig = async (configObject) => {
		await fsp.writeFile(
			path.join(configDir, "cli-config.json"),
			`${JSON.stringify(configObject, null, 2)}\n`,
			{ mode: 0o600 },
		);
	};
	const writeRawConfig = async (text) => {
		await fsp.writeFile(path.join(configDir, "cli-config.json"), text, { mode: 0o600 });
	};
	const writePermissionsJson = async (obj) => {
		await fsp.writeFile(path.join(configDir, "permissions.json"), `${JSON.stringify(obj, null, 2)}\n`, {
			mode: 0o600,
		});
	};
	const snapshotCursorDir = async () => {
		try {
			return (await fsp.readdir(configDir)).sort();
		} catch {
			return [];
		}
	};
	return { root, home, configDir, ws, writeConfig, writeRawConfig, writePermissionsJson, snapshotCursorDir };
}

// ---------------------------------------------------------------------------
// CLI resolution
// ---------------------------------------------------------------------------

function resolveCliExecutable(explicit) {
	if (explicit) {
		if (fs.existsSync(explicit)) return explicit;
		throw infra(`--cli path does not exist: ${explicit}`);
	}
	const candidates = [];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		candidates.push(path.join(dir, "cursor-agent"));
	}
	candidates.push(path.join(os.homedir(), ".local", "bin", "cursor-agent"));
	const versionsRoot = path.join(os.homedir(), ".local", "share", "cursor-agent", "versions");
	try {
		const versions = fs
			.readdirSync(versionsRoot)
			.filter((v) => fs.existsSync(path.join(versionsRoot, v, "cursor-agent")))
			.sort()
			.reverse();
		for (const v of versions) candidates.push(path.join(versionsRoot, v, "cursor-agent"));
	} catch {
		// no versions dir
	}
	for (const c of candidates) {
		try {
			if (fs.statSync(c).isFile() || fs.statSync(c).isSymbolicLink()) return c;
		} catch {
			// keep scanning
		}
	}
	throw infra(
		"cursor-agent executable not found on PATH, ~/.local/bin, or ~/.local/share/cursor-agent/versions/*",
	);
}

// ---------------------------------------------------------------------------
// keychain credential read (values never leave memory / the temp auth.json)
// ---------------------------------------------------------------------------

function readKeychainToken(service) {
	const res = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 64 * 1024,
	});
	if (res.error || res.status !== 0) {
		throw infra(
			`keychain read failed for ${service} (status=${res.status}, stderr=${(res.stderr ?? "").trim().slice(0, 200)})`,
		);
	}
	const token = (res.stdout ?? "").replace(/\r?\n$/, "");
	if (!token) throw infra(`keychain returned an empty token for ${service}`);
	return token;
}

// ---------------------------------------------------------------------------
// CLI runner with hard timeout and process-group kill
// ---------------------------------------------------------------------------

function runCli(executable, { home, ws }, extraArgs, timeoutMs) {
	return new Promise((resolve) => {
		const env = {
			// Strict allowlist; auth-bearing env is deliberately absent.
			PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
			HOME: home,
			TMPDIR: path.join(path.dirname(home)), // keep CLI scratch inside the probe temp root
			TERM: "dumb",
			LANG: process.env.LANG ?? "en_US.UTF-8",
			LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
			FORCE_COLOR: "0",
			AGENT_CLI_CREDENTIAL_STORE: "file",
		};
		const args = [
			"-p",
			PROBE_PROMPT,
			"--output-format",
			"stream-json",
			"--model",
			MODEL,
			"--trust",
			"--force",
			...extraArgs,
		];
		const startedAt = Date.now();
		// detached: own process group so the whole tree can be killed on timeout.
		const child = spawn(executable, args, { cwd: ws, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let timedOut = false;
		let settled = false;

		const cap = (chunk, current, max) =>
			current.length + chunk.length <= max ? current + chunk : (current + chunk).slice(0, max);

		child.stdout.on("data", (d) => {
			const s = d.toString("utf8");
			if (stdout.length >= MAX_STDOUT_BYTES) stdoutTruncated = true;
			else stdout = cap(s, stdout, MAX_STDOUT_BYTES);
		});
		child.stderr.on("data", (d) => {
			const s = d.toString("utf8");
			if (stderr.length >= MAX_STDERR_BYTES) stderrTruncated = true;
			else stderr = cap(s, stderr, MAX_STDERR_BYTES);
		});

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
			setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}, 3000);
		}, timeoutMs);

		const finish = (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				argvTail: extraArgs,
				exitCode: code,
				signal: signal ?? null,
				timedOut,
				durationMs: Date.now() - startedAt,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
			});
		};
		child.on("close", (code, signal) => finish(code, signal));
		child.on("error", (err) => {
			stderr += `\n[probe] spawn error: ${err.message}`;
			finish(null, null);
		});
	});
}

// ---------------------------------------------------------------------------
// stream-json parsing -> positive evidence
// ---------------------------------------------------------------------------

/** Bounded deep search for a `result` object carrying success/rejected/permissionDenied. */
function findToolResults(frame) {
	const results = [];
	const visit = (node, depth) => {
		if (!node || typeof node !== "object" || depth > 8) return;
		for (const [key, value] of Object.entries(node)) {
			if (key === "result" && value && typeof value === "object") {
				if ("success" in value || "rejected" in value || "permissionDenied" in value) {
					results.push(value);
				}
			} else {
				visit(value, depth + 1);
			}
		}
	};
	visit(frame, 0);
	return results;
}

function parseStream(stdout) {
	const eventCounts = {};
	const toolResults = [];
	const denialEvents = [];
	let assistantText = "";
	let initFrame = null;
	let parseFailures = 0;
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const brace = line.indexOf("{");
		if (brace < 0) continue;
		let frame;
		try {
			frame = JSON.parse(line.slice(brace));
		} catch {
			parseFailures++;
			continue;
		}
		const key = `${frame.type ?? "?"}/${frame.subtype ?? "-"}`;
		eventCounts[key] = (eventCounts[key] ?? 0) + 1;
		if (frame.type === "system" && frame.subtype === "init") initFrame = frame;
		if (frame.type === "assistant" && frame.message?.content) {
			for (const part of frame.message.content) {
				if (part?.type === "text" && typeof part.text === "string") assistantText += part.text;
			}
		}
		if (frame.type === "tool_call") {
			for (const result of findToolResults(frame)) toolResults.push(result);
		}
		// Denial-shaped frames outside tool_call (e.g. permissionDenied events).
		if (frame.type !== "tool_call" && /permissionDenied|Command blocked by permissions configuration/.test(line)) {
			denialEvents.push({ key, snippet: line.slice(brace, brace + 300) });
		}
	}
	return { eventCounts, toolResults, denialEvents, assistantText, initFrame, parseFailures };
}

/**
 * Positive-evidence classification. Absence of stdout is NOT proof of denial;
 * execution requires a success result whose stdout carries the sentinel, and
 * denial requires a rejected/permissionDenied result naming the sentinel
 * command.
 */
function classifyRun(parsed) {
	let executed = false;
	let denied = false;
	const evidence = [];
	for (const result of parsed.toolResults) {
		if (result.success) {
			const stdout = typeof result.success.stdout === "string" ? result.success.stdout : "";
			const command = typeof result.success.command === "string" ? result.success.command : "";
			evidence.push({
				kind: "success",
				command,
				exitCode: result.success.exitCode,
				stdoutHasSentinel: stdout.includes(SENTINEL),
			});
			if (stdout.includes(SENTINEL)) executed = true;
		}
		if (result.rejected) {
			const command = typeof result.rejected.command === "string" ? result.rejected.command : "";
			evidence.push({
				kind: "rejected",
				command,
				reason: result.rejected.reason,
				isReadonly: result.rejected.isReadonly,
			});
			if (command.includes(SENTINEL)) denied = true;
		}
		if (result.permissionDenied) {
			const command =
				typeof result.permissionDenied.command === "string" ? result.permissionDenied.command : "";
			evidence.push({
				kind: "permissionDenied",
				command,
				error: result.permissionDenied.error,
				isReadonly: result.permissionDenied.isReadonly,
			});
			if (command.includes(SENTINEL)) denied = true;
		}
	}
	for (const ev of parsed.denialEvents) {
		evidence.push({ kind: "denialEvent", ...ev });
		if (ev.snippet.includes(SENTINEL) || /Command blocked by permissions configuration/.test(ev.snippet)) {
			denied = true;
		}
	}
	return { executed, denied, evidence };
}

function summarizeRun(run, parsed, classification) {
	return {
		exitCode: run.exitCode,
		signal: run.signal,
		timedOut: run.timedOut,
		durationMs: run.durationMs,
		stdoutTruncated: run.stdoutTruncated,
		eventCounts: parsed.eventCounts,
		parseFailures: parsed.parseFailures,
		init: parsed.initFrame
			? {
					apiKeySource: parsed.initFrame.apiKeySource,
					permissionMode: parsed.initFrame.permissionMode,
					model: parsed.initFrame.model,
				}
			: null,
		executed: classification.executed,
		denied: classification.denied,
		toolResultEvidence: classification.evidence,
		stderrFirstLine: (run.stderr ?? "").split("\n").find((l) => l.trim()) ?? "",
	};
}

// ---------------------------------------------------------------------------
// main probe sequence
// ---------------------------------------------------------------------------

const details = {
	probeStartedAt: new Date().toISOString(),
	model: MODEL,
	timeoutMs: ARGS.timeoutMs,
};

const executable = resolveCliExecutable(ARGS.cli);

// CLI version (10s deadline, informational only).
const versionRes = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
details.cli = {
	executable,
	version: (versionRes.stdout ?? "").trim() || null,
};

// Credentials from the keychain; kept in memory only.
const accessToken = readKeychainToken("cursor-access-token");
const refreshToken = readKeychainToken("cursor-refresh-token");
details.auth = {
	accessTokenLength: accessToken.length,
	refreshTokenLength: refreshToken.length,
};

/**
 * One full echo-probe run in a fresh sandbox HOME.
 * `setup` may write config files before the run.
 */
async function probeRun(label, extraArgs, setup) {
	const sandbox = await makeSandboxHome(label, accessToken, refreshToken);
	try {
		if (setup) await setup(sandbox);
		const configFilesBefore = await sandbox.snapshotCursorDir();
		const run = await runCli(executable, sandbox, extraArgs, ARGS.timeoutMs);
		const parsed = parseStream(run.stdout);
		const classification = classifyRun(parsed);
		const configFilesAfter = await sandbox.snapshotCursorDir();
		return {
			...summarizeRun(run, parsed, classification),
			configFilesBefore,
			configFilesAfter,
			configRewrittenOrBackedUp: JSON.stringify(configFilesAfter) !== JSON.stringify(configFilesBefore),
		};
	} finally {
		// Remove each temp HOME as soon as its run is done.
		await fsp.rm(sandbox.root, { recursive: true, force: true });
		const idx = tempRoots.indexOf(sandbox.root);
		if (idx >= 0) tempRoots.splice(idx, 1);
	}
}

/** Retry once on transport-looking failures (no init frame AND non-zero/timeout exit, not an argv rejection). */
async function probeRunWithRetry(label, extraArgs, setup) {
	const first = await probeRun(label, extraArgs, setup);
	const argvRejected = /invalid|allowed choices|argument/i.test(first.stderrFirstLine ?? "");
	const transportFlake =
		!argvRejected &&
		(first.timedOut ||
			(first.exitCode !== 0 && !(first.eventCounts["system/init"] >= 1) && !first.toolResultEvidence.length));
	if (!transportFlake) return { attempt: 1, ...first };
	const second = await probeRun(`${label}-retry`, extraArgs, setup);
	return {
		attempt: 2,
		retriedAfter: {
			exitCode: first.exitCode,
			timedOut: first.timedOut,
			eventCounts: first.eventCounts,
			stderrFirstLine: first.stderrFirstLine,
		},
		...second,
	};
}

// --- (a) control run: no config file; the echo MUST execute under --force ---
process.stdout.write("[probe] control run (no cli-config.json, --force)...\n");
const control = await probeRunWithRetry("control", []);
details.controlRun = control.retriedAfter ? { attempts: 2 } : { attempts: 1 };
details.controlRun.result = control;
if (!control.executed) {
	throw infra(
		`control run did not execute \`echo ${SENTINEL}\` under --force (exit=${control.exitCode}, events=${JSON.stringify(control.eventCounts)}); cannot judge deny candidates`,
	);
}
if (control.denied) {
	throw infra("control run without any config showed a denial signal; baseline is inconsistent");
}

// --- (a) deny candidates, one fresh HOME each; stop at first positive proof ---
// Shapes derived from the installed bundle (zod schema `permissions: {allow:
// string[], deny: string[]}` in cli-config.json; deny entries of the form
// `Shell(<pattern>)`; partial configs are deep-merged over defaults).
const DENY_CANDIDATES = [
	{
		name: "cli-config.minimal.Shell-exact",
		config: { permissions: { deny: [`Shell(echo ${SENTINEL})`] } },
	},
	{
		name: "cli-config.full.Shell-exact",
		config: {
			version: 1,
			editor: { vimMode: false },
			permissions: { allow: ["Shell(ls)"], deny: [`Shell(echo ${SENTINEL})`] },
		},
	},
	{
		name: "cli-config.minimal.Shell-name",
		config: { permissions: { deny: ["Shell(echo)"] } },
	},
	{
		name: "cli-config.minimal.Shell-glob",
		config: { permissions: { deny: ["Shell(echo *)"] } },
	},
	{
		name: "cli-config.minimal.bare-exact",
		config: { permissions: { deny: [`echo ${SENTINEL}`] } },
	},
	{
		name: "cli-config.minimal.bare-glob",
		config: { permissions: { deny: ["echo *"] } },
	},
];

let denyListSupported = false;
let provenConfigShape = null;
let provenCandidateName = null;
details.denyCandidates = [];
for (const candidate of DENY_CANDIDATES) {
	process.stdout.write(`[probe] deny candidate: ${candidate.name}...\n`);
	const result = await probeRunWithRetry(candidate.name, [], (s) => s.writeConfig(candidate.config));
	details.denyCandidates.push({ name: candidate.name, config: candidate.config, result });
	if (result.denied && !result.executed) {
		denyListSupported = true;
		provenConfigShape = candidate.config;
		provenCandidateName = candidate.name;
		break;
	}
}

// --- adversarial: malformed config shapes must not crash the probe ---
details.malformedRuns = [];
const MALFORMED = [
	{
		name: "malformed.type-invalid-deny",
		setup: (s) => s.writeConfig({ permissions: { deny: `echo ${SENTINEL}` } }), // string, not array
	},
	{ name: "malformed.truncated-json", setup: (s) => s.writeRawConfig("{permissions") },
];
for (const m of MALFORMED) {
	process.stdout.write(`[probe] malformed config: ${m.name}...\n`);
	const result = await probeRunWithRetry(m.name, [], m.setup);
	details.malformedRuns.push({ name: m.name, result });
}

// --- diagnostic: permissions.json is allow-only in the bundle; confirm no deny effect ---
process.stdout.write("[probe] permissions.json deny diagnostic...\n");
const permissionsJsonRun = await probeRunWithRetry("permissions-json", [], (s) =>
	s.writePermissionsJson({ deny: [`Shell(echo ${SENTINEL})`] }),
);
details.permissionsJsonDenyRun = {
	expected: "no effect (bundle hardcodes deny: [] for permissions.json)",
	result: permissionsJsonRun,
};

// --- (b) sandbox modes: accept/reject from the CLI's own output + echo effect ---
const SANDBOX_MODES = ["off", "workspace-write", "read-only", "require-approval", "enabled", "disabled"];
details.sandboxModes = [];
const sandboxModesAccepted = [];
const sandboxObservations = {};
for (const mode of SANDBOX_MODES) {
	process.stdout.write(`[probe] sandbox mode: ${mode}...\n`);
	const result = await probeRunWithRetry(`sandbox-${mode}`, ["--sandbox", mode]);
	const invalidChoiceLine =
		(result.stderrFirstLine || "").trim().length > 0 && /invalid|allowed choices|argument/i.test(result.stderrFirstLine)
			? result.stderrFirstLine
			: null;
	const rejected = result.exitCode !== 0 || result.timedOut;
	const entry = {
		mode,
		accepted: !rejected,
		rejectError: rejected ? (invalidChoiceLine ?? (result.stderrFirstLine || `exit ${result.exitCode}`)) : null,
		echoOutcome: result.executed ? "executed" : result.denied ? "denied" : "no-execution-signal",
		result: { exitCode: result.exitCode, timedOut: result.timedOut, eventCounts: result.eventCounts },
	};
	details.sandboxModes.push(entry);
	if (!rejected) {
		sandboxModesAccepted.push(mode);
		sandboxObservations[mode] = {
			echoOutcome: entry.echoOutcome,
			initPermissionMode: result.init?.permissionMode ?? null,
			exitCode: result.exitCode,
		};
	}
}

let sandboxEffect;
if (sandboxModesAccepted.length === 0) {
	sandboxEffect = "no probed --sandbox value was accepted";
} else {
	sandboxEffect = sandboxModesAccepted
		.map((m) => `${m}: ${sandboxObservations[m].echoOutcome} (rc=${sandboxObservations[m].exitCode})`)
		.join("; ");
}

// ---------------------------------------------------------------------------
// cleanup + report
// ---------------------------------------------------------------------------

const removed = await cleanupTempRoots();
details.cleanupReceipt = {
	tempRootsCreated,
	removedAtClose: removed.length,
	allRemoved: removed.every((r) => !r.includes("FAILED")),
	remainingAfterCleanup: tempRoots.length,
};
details.probeFinishedAt = new Date().toISOString();
details.provenCandidateName = provenCandidateName;

const report = {
	denyListSupported,
	provenConfigShape,
	sandboxModesAccepted,
	sandboxEffect,
	details,
};

const outPath = path.resolve(ARGS.out);
await fsp.mkdir(path.dirname(outPath), { recursive: true });
await fsp.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });

process.stdout.write(
	`[probe] done: denyListSupported=${denyListSupported} sandboxModesAccepted=[${sandboxModesAccepted.join(", ")}]\n`,
);
process.stdout.write(`[probe] report: ${outPath}\n`);
process.exit(0);
