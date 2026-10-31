/**
 * senpi-qa shared harness (cross-platform: macOS, Linux, Windows).
 *
 * Every QA channel imports from here so isolation, cleanup, and evidence
 * handling are identical across rpc-drive / mock-loop / tui-smoke / cli-smoke.
 *
 * Why Node (not bash/tmux): the QA channels must run natively on every OS
 * including Windows. Pure-Node spawning + node-pty give one code path
 * everywhere instead of a POSIX-only shell harness.
 *
 * Run `node common.mjs --self-check` to verify the harness against the live
 * machine (it is its own regression test).
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Repo + runtime resolution
// ---------------------------------------------------------------------------

/** Walk up from this file until we find the senpi repo root (has packages/coding-agent/src/cli.ts). */
export function repoRoot() {
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "packages", "coding-agent", "src", "cli.ts"))) return dir;
		dir = dirname(dir);
	}
	throw new Error("Could not locate senpi repo root from " + __dirname);
}

/** Path to the coding-agent CLI entry (TypeScript source — run via tsx, like pi-test.sh). */
export function cliEntry(root = repoRoot()) {
	return join(root, "packages", "coding-agent", "src", "cli.ts");
}

/** Path to the tsx ESM CLI used to run the TypeScript source without a build. */
export function tsxEntry(root = repoRoot()) {
	return join(root, "node_modules", "tsx", "dist", "cli.mjs");
}

/** piConfig-derived constants (source of truth: packages/coding-agent/package.json). */
export const APP_NAME = "senpi";
export const CONFIG_DIR_NAME = ".senpi";
export const ENV_AGENT_DIR = "SENPI_CODING_AGENT_DIR";
export const ENV_SESSION_DIR = "SENPI_CODING_AGENT_SESSION_DIR";

/** Absolute path to the REAL user agent dir (must never be mutated by QA). */
export function realAgentDir() {
	return process.env[ENV_AGENT_DIR] || join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Absolute path to the REAL auth.json (credentials — never read/written by QA). */
export function realAuthPath() {
	return join(realAgentDir(), "auth.json");
}

// ---------------------------------------------------------------------------
// Isolated sandbox
// ---------------------------------------------------------------------------

const sandboxes = new Set();

/**
 * Inherited variables that must never cross into a QA sandbox. A branded parent
 * session (the omo launcher) exports SENPI_BRAND plus <envPrefix>_* overrides
 * such as OMO_CODING_AGENT_DIR; the CLI resolves settings brand-prefix-first
 * (brandEnvNames in src/core/brand.ts), so those overrides silently outrank the
 * SENPI_* pins below and the "isolated" CLI reads the REAL agent dir.
 * SENPI_RUNTIME is a bun-runtime opt-in that would lie to a node-spawned CLI,
 * PI_PROMPT_CACHE_SAFE_WAIT_SECONDS steers cache timing, and PI_SESSION_FILE /
 * PI_SESSION_ID point at the parent session's live transcript.
 */
const SCRUBBED_SESSION_ENV = [
	"SENPI_BRAND",
	"SENPI_RUNTIME",
	"PI_PROMPT_CACHE_SAFE_WAIT_SECONDS",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
];

/** envPrefix of the inherited brand profile, if any (mirrors parseBrandProfile's fallback). */
function brandEnvPrefix(raw) {
	try {
		const profile = JSON.parse(raw);
		const prefix = profile?.envPrefix ?? profile?.name;
		return typeof prefix === "string" && prefix.trim() ? prefix.trim().toUpperCase() : undefined;
	} catch {
		return undefined;
	}
}

/** Remove inherited brand/session steering vars from a spawned-CLI env; returns the scrubbed names. */
export function scrubSandboxEnv(env) {
	const scrubbed = [];
	const prefix = brandEnvPrefix(env.SENPI_BRAND);
	for (const name of Object.keys(env)) {
		if (SCRUBBED_SESSION_ENV.includes(name) || (prefix !== undefined && name.startsWith(`${prefix}_`))) {
			delete env[name];
			scrubbed.push(name);
		}
	}
	return scrubbed;
}

/**
 * Create an isolated agent/session sandbox so QA never touches the real ~/.senpi.
 * Returns { dir, agentDir, sessionDir, cwd, env, cleanup }.
 * `env` is meant to be merged into spawn options (it already includes offline flags).
 */
export function makeSandbox(label = "senpi-qa") {
	const dir = mkdtempSync(join(tmpdir(), `${label}-`));
	const agentDir = join(dir, "agent");
	const sessionDir = join(dir, "sessions");
	const cwd = join(dir, "work");
	// Owner-only, whatever the umask: an RPC host refuses to publish its key into a group-writable agent dir.
	for (const d of [agentDir, sessionDir, cwd]) mkdirSync(d, { recursive: true, mode: 0o700 });

	const env = { ...process.env };
	scrubSandboxEnv(env);
	Object.assign(env, {
		[ENV_AGENT_DIR]: agentDir,
		[ENV_SESSION_DIR]: sessionDir,
		// Keep QA hermetic and quiet: no startup network, no telemetry.
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		// HOME-derived senpi paths (package discovery, omo-native detection, omo-local-update)
		// must resolve inside the sandbox, and the local-update path swap must stay disarmed.
		HOME: dir,
		USERPROFILE: dir,
		SENPI_OMO_LOCAL_UPDATE: "0",
		// Never let an interactive pager/editor hang a captured run.
		PAGER: "cat",
		GIT_PAGER: "cat",
	});

	const box = {
		dir,
		agentDir,
		sessionDir,
		cwd,
		env,
		cleanup() {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
			sandboxes.delete(box);
		},
	};
	sandboxes.add(box);
	return box;
}

// ---------------------------------------------------------------------------
// Child runtime (the runtime the tested CLI runs on)
// ---------------------------------------------------------------------------

const MIN_CHILD_BUN = [1, 4, 0];

/** First executable named `name` on PATH (plus `extraDirs`), or undefined. */
function findOnPath(name, extraDirs = []) {
	const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
	const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...extraDirs];
	for (const dir of dirs) {
		for (const file of names) {
			if (existsSync(join(dir, file))) return join(dir, file);
		}
	}
	return undefined;
}

function versionOf(command) {
	const out = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 });
	if (out.status !== 0) throw new Error(`${command} --version failed: ${out.stderr || out.error?.message || out.status}`);
	return out.stdout.trim().replace(/^v/, "");
}

/**
 * The Bun the harness runs Bun-only work on: this process's own Bun, else `bun` on PATH or in
 * ~/.bun/bin. Throws unless it is at least 1.4.0. Returns { command, version }.
 */
export function resolveBun() {
	const command = process.versions.bun ? process.execPath : findOnPath("bun", [join(homedir(), ".bun", "bin")]);
	if (!command) throw new Error("senpi-qa needs Bun >= 1.4.0 on PATH (or ~/.bun/bin) to start the tested CLI");
	const version = process.versions.bun ?? versionOf(command);
	const parts = version.split(".").map((part) => Number.parseInt(part, 10));
	const tooOld = MIN_CHILD_BUN.some((min, index) => {
		const earlier = MIN_CHILD_BUN.slice(0, index).every((value, j) => parts[j] === value);
		return earlier && (parts[index] ?? 0) < min;
	});
	if (tooOld) throw new Error(`senpi-qa needs Bun >= ${MIN_CHILD_BUN.join(".")}; ${command} is ${version}`);
	return { command, version };
}

/**
 * Which runtime the tested CLI starts on, from the driver's `--child` flag:
 * - absent: the resolved Bun (>= 1.4.0), running the CLI source;
 * - `--child binary:<path>`: the compiled binary at <path>;
 * - `--child node`: Node + tsx (only for the Node smoke runs).
 * Returns { kind, command, label }; `label` is the receipt's `child_runtime`.
 */
export function resolveChildRuntime(argv = process.argv) {
	const index = argv.indexOf("--child");
	const spec = index >= 0 ? argv[index + 1] : undefined;
	if (index < 0) {
		const bun = resolveBun();
		return { kind: "bun", command: bun.command, label: `bun@${bun.version}` };
	}
	if (spec === "node") {
		const command = process.versions.bun ? findOnPath("node") : process.execPath;
		if (!command) throw new Error("--child node needs node on PATH");
		const version = process.versions.bun ? versionOf(command) : process.versions.node;
		return { kind: "node", command, label: `node@${version}` };
	}
	if (spec?.startsWith("binary:") && spec.length > "binary:".length) {
		const command = spec.slice("binary:".length);
		if (!existsSync(command)) throw new Error(`--child binary: no file at ${command}`);
		return { kind: "binary", command, label: `binary:${command}` };
	}
	throw new Error(`--child must be "node" or "binary:<path>", got ${JSON.stringify(spec)}`);
}

let resolvedChildRuntime;
/** This driver's child runtime, resolved once from process.argv on first use. */
export function childRuntime() {
	resolvedChildRuntime ??= resolveChildRuntime();
	return resolvedChildRuntime;
}

// ---------------------------------------------------------------------------
// CLI spawning (tests the live working tree, or the compiled binary)
// ---------------------------------------------------------------------------

/**
 * Spawn the coding-agent CLI on this driver's child runtime (see resolveChildRuntime).
 * Returns the ChildProcess. Use for streaming protocols (RPC). For one-shot capture use runCli().
 */
export function spawnCli(args, { env, cwd, stdio } = {}) {
	const root = repoRoot();
	const runtime = childRuntime();
	const argv =
		runtime.kind === "binary"
			? args
			: runtime.kind === "bun"
				? [cliEntry(root), ...args]
				: [tsxEntry(root), "--tsconfig", join(root, "tsconfig.json"), cliEntry(root), ...args];
	const child = spawn(runtime.command, argv, {
		cwd: cwd || root,
		env: env || process.env,
		stdio: stdio || ["pipe", "pipe", "pipe"],
	});
	track(child);
	return child;
}

/** Run the CLI once and capture {code, stdout, stderr}. Kills on timeout. */
export function runCli(args, { env, cwd, timeoutMs = 60000, input } = {}) {
	return new Promise((resolve) => {
		const child = spawnCli(args, { env, cwd });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve({ code: null, stdout, stderr, timedOut: true });
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut: false });
		});
		// Always close stdin: non-interactive modes (e.g. --print) can block
		// reading piped input until EOF, which would hang the captured run.
		try {
			if (input !== undefined) child.stdin.write(input);
			child.stdin.end();
		} catch {}
	});
}

// ---------------------------------------------------------------------------
// Process / port tracking + cleanup
// ---------------------------------------------------------------------------

const tracked = new Set();

/** Track a child process or anything with a kill()/close() so cleanupAll() reaps it. */
export function track(proc) {
	tracked.add(proc);
	return proc;
}

/** Kill/close everything tracked and remove every sandbox. Idempotent. */
export function cleanupAll() {
	for (const p of tracked) {
		try {
			if (typeof p.kill === "function" && p.exitCode === null) p.kill("SIGKILL");
			else if (typeof p.close === "function") p.close();
		} catch {}
	}
	tracked.clear();
	for (const box of [...sandboxes]) box.cleanup();
}

let hooked = false;
/** Install exit/signal handlers that run cleanupAll() exactly once. */
export function installCleanupHooks() {
	if (hooked) return;
	hooked = true;
	const once = () => cleanupAll();
	process.on("exit", once);
	for (const sig of ["SIGINT", "SIGTERM"]) {
		process.on(sig, () => {
			cleanupAll();
			process.exit(130);
		});
	}
}

/** Find a free TCP port by binding to 0 and reading the assigned port. */
export function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

// ---------------------------------------------------------------------------
// Credential integrity (the one invariant QA must never break)
// ---------------------------------------------------------------------------

function sha256OrNull(path) {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null; // absent file is a valid state
	}
}

/**
 * Snapshot the real auth.json. Returns { assertUnchanged } which throws if the
 * file changed (or appeared/disappeared) since the snapshot.
 */
export function guardRealAuth() {
	const path = realAuthPath();
	const before = sha256OrNull(path);
	return {
		path,
		before,
		assertUnchanged() {
			const after = sha256OrNull(path);
			if (before !== after) {
				throw new Error(`Real credential file changed during QA: ${path} (${before} -> ${after})`);
			}
			return true;
		},
	};
}

export { inspectProcess, OwnedSignalRefusedError, signalOwnedProcess } from "./owned-signal.mjs";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Two-digit-padded YYYYMMDD in local time. */
export function dateStamp(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Create (and return) local-ignore/qa-evidence/<date>-<slug>/ under the repo root. */
export function evidenceDir(slug) {
	if (typeof slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
		throw new Error("Evidence slug must be a single safe path segment.");
	}
	const dir = join(repoRoot(), "local-ignore", "qa-evidence", `${dateStamp()}-${slug}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Strip ANSI escape sequences so TUI captures can be asserted as plain text. */
export function stripAnsi(s) {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[=>]/g, "");
}

/** Read a JSON file or return a fallback. */
export function readJsonl(text) {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return { __unparsed: l };
			}
		});
}

// ---------------------------------------------------------------------------
// Tiny assertion runner shared by every --self-test / --self-check
// ---------------------------------------------------------------------------

export function createChecks(title) {
	const results = [];
	return {
		ok(name, cond, detail = "") {
			results.push({ name, pass: !!cond, detail });
			const mark = cond ? "PASS" : "FAIL";
			process.stdout.write(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}\n`);
			return !!cond;
		},
		async run(name, fn) {
			try {
				const detail = await fn();
				return this.ok(name, true, typeof detail === "string" ? detail : "");
			} catch (e) {
				return this.ok(name, false, e instanceof Error ? e.message : String(e));
			}
		},
		finish() {
			const failed = results.filter((r) => !r.pass).length;
			process.stdout.write(`\n${title}: ${results.length - failed}/${results.length} passed\n`);
			return failed === 0;
		},
	};
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

async function selfCheck() {
	installCleanupHooks();
	const checks = createChecks("common.mjs --self-check");

	let root;
	checks.ok("repo root resolves", (() => {
		try {
			root = repoRoot();
			return existsSync(cliEntry(root));
		} catch {
			return false;
		}
	})(), root);

	checks.ok("tsx entry present", existsSync(tsxEntry(root)), tsxEntry(root));

	const box = makeSandbox("self-check");
	checks.ok(
		"sandbox isolates agent + session dirs",
		existsSync(box.agentDir) &&
			existsSync(box.sessionDir) &&
			box.env[ENV_AGENT_DIR] === box.agentDir &&
			box.env[ENV_SESSION_DIR] === box.sessionDir &&
			box.env.PI_OFFLINE === "1" &&
			box.env.HOME === box.dir &&
			box.env.USERPROFILE === box.dir &&
			box.env.SENPI_OMO_LOCAL_UPDATE === "0",
		box.dir,
	);

	// A branded parent session (the omo launcher) exports SENPI_BRAND plus
	// <envPrefix>_* overrides and session-steering vars; none may cross into a sandbox.
	const leakedFixture = {
		SENPI_BRAND: JSON.stringify({ name: "OmO", configDir: ".omo", envPrefix: "OMO", userAgent: "omo" }),
		OMO_CODING_AGENT_DIR: "/tmp/qa-real-agent",
		OMO_NATIVE: "1",
		SENPI_RUNTIME: "bun",
		PI_PROMPT_CACHE_SAFE_WAIT_SECONDS: "270",
		PI_SESSION_FILE: "/tmp/qa-real-session.jsonl",
		PI_SESSION_ID: "qa-real-session",
	};
	const savedFixture = new Map();
	for (const [key, value] of Object.entries(leakedFixture)) {
		savedFixture.set(key, process.env[key]);
		process.env[key] = value;
	}
	const leakedBox = makeSandbox("self-check-leak");
	for (const [key, value] of savedFixture) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	checks.ok(
		"sandbox scrubs inherited brand/session env",
		Object.keys(leakedFixture).every((key) => leakedBox.env[key] === undefined) &&
			leakedBox.env[ENV_AGENT_DIR] === leakedBox.agentDir,
		`scrubbed=${Object.keys(leakedFixture).filter((key) => leakedBox.env[key] === undefined).length}/${Object.keys(leakedFixture).length}`,
	);
	leakedBox.cleanup();

	const guard = guardRealAuth();
	checks.ok("real auth snapshot taken", true, guard.before ? `sha256=${guard.before.slice(0, 12)}…` : "absent");

	const port = await freePort();
	checks.ok("free port allocatable", Number.isInteger(port) && port > 1023 && port < 65536, String(port));

	const ev = evidenceDir("self-check");
	checks.ok("evidence dir creatable under local-ignore", existsSync(ev), ev);

	checks.ok("ansi stripping", stripAnsi("[31mred[0m") === "red");

	// Cleanup must remove the sandbox.
	box.cleanup();
	checks.ok("sandbox removed on cleanup", !existsSync(box.dir), box.dir);

	// The real credential file must be untouched by everything above.
	checks.ok("real auth unchanged", (() => {
		try {
			return guard.assertUnchanged();
		} catch {
			return false;
		}
	})(), guard.path);

	// Remove the self-check evidence dir we just made (keep local-ignore tidy).
	try {
		rmSync(ev, { recursive: true, force: true });
	} catch {}

	const passed = checks.finish();
	process.exit(passed ? 0 : 1);
}

if (process.argv[2] === "--self-check") {
	selfCheck();
}
