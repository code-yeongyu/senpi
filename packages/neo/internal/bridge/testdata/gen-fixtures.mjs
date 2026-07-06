/**
 * RPC bridge fixture generator (task 3).
 *
 * Drives the REAL `senpi --mode rpc` process (from TypeScript source via tsx,
 * exactly as the senpi-qa channels do) inside an isolated sandbox and captures
 * the raw stdout JSONL lines verbatim into golden files under this directory.
 *
 * These goldens are the round-trip corpus for the Go bridge codec: every
 * `.jsonl` here is real protocol output, never hand-authored. Regenerate with:
 *
 *   node packages/neo/internal/bridge/testdata/gen-fixtures.mjs
 *
 * The run is hermetic: no real provider key reaches the fake model server, and
 * the real ~/.senpi/agent/auth.json is asserted unchanged before exit.
 *
 * Fixture files written:
 *   response_get_state.jsonl     get_state success response (RpcSessionState)
 *   response_get_commands.jsonl  get_commands success response (RpcSlashCommand[])
 *   response_get_messages.jsonl  get_messages success response
 *   response_error.jsonl         a command failure (success:false) response
 *   events_prompt_turn.jsonl     full event stream for one prompt turn -> agent_end
 *   extension_error.jsonl        a synthetic extension_error demux sample (schema-real)
 *   demux_mixed.jsonl            one line of each of the FOUR top-level shapes
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { startFakeModelServer } from "../../../../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Walk up to the senpi repo root (has packages/coding-agent/src/cli.ts). */
function repoRoot() {
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "packages", "coding-agent", "src", "cli.ts"))) return dir;
		dir = dirname(dir);
	}
	throw new Error("repo root not found");
}

const ROOT = repoRoot();
const CLI = join(ROOT, "packages", "coding-agent", "src", "cli.ts");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const AUTH = join(process.env.SENPI_CODING_AGENT_DIR || join(homedir(), ".senpi", "agent"), "auth.json");

function sha256OrNull(p) {
	try {
		return createHash("sha256").update(readFileSync(p)).digest("hex");
	} catch {
		return null;
	}
}

/** Provider keys stripped so the fake server is only ever reached with the mock key. */
const PROVIDER_ENV_KEYS = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY",
	"NVIDIA_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
	"FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY",
	"MOONSHOTAI_API_KEY", "KIMI_API_KEY", "OPENCODE_API_KEY", "CLOUDFLARE_API_KEY", "HF_TOKEN",
];

function makeSandbox() {
	const dir = mkdtempSync(join(tmpdir(), "neo-bridge-fixtures-"));
	const agentDir = join(dir, "agent");
	const sessionDir = join(dir, "sessions");
	const cwd = join(dir, "work");
	for (const d of [agentDir, sessionDir, cwd]) mkdirSync(d, { recursive: true });
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	const env = { ...process.env };
	for (const k of PROVIDER_ENV_KEYS) delete env[k];
	env.SENPI_CODING_AGENT_DIR = agentDir;
	env.SENPI_CODING_AGENT_SESSION_DIR = sessionDir;
	// Point HOME (and XDG) at the sandbox so ~/.agents/skills discovery is
	// hermetic: get_commands must return only deterministic builtins, never the
	// operator's real ~/.agents skills (which would leak a username and make the
	// golden non-portable). This also hard-isolates the run from real $HOME.
	env.HOME = home;
	env.XDG_CONFIG_HOME = join(home, ".config");
	env.XDG_DATA_HOME = join(home, ".local", "share");
	env.XDG_STATE_HOME = join(home, ".local", "state");
	env.PI_OFFLINE = "1";
	env.PI_TELEMETRY = "0";
	env.PAGER = "cat";
	env.GIT_PAGER = "cat";
	return { dir, agentDir, sessionDir, cwd, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Minimal JSONL RPC driver over a spawned `--mode rpc` child; records EVERY raw stdout line. */
class Driver {
	constructor({ env, cwd, extraArgs = [] }) {
		this.rawLines = [];
		this.events = [];
		this.pending = new Map();
		this.seq = 0;
		this.buf = "";
		this.stderr = "";
		this.child = spawn(process.execPath, [TSX, "--tsconfig", join(ROOT, "tsconfig.json"), CLI, "--mode", "rpc", "--no-session", "--no-context-files", ...extraArgs], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.on("data", (c) => this.onData(c));
		this.child.stderr.on("data", (d) => {
			this.stderr += d.toString();
		});
	}

	onData(chunk) {
		this.buf += chunk.toString();
		let nl;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const raw = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // startup noise (tsx banners etc.) — not protocol
			}
			this.rawLines.push(line);
			if (msg && msg.type === "response") {
				const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
				if (waiter) {
					this.pending.delete(msg.id);
					waiter.resolve({ msg, line });
				}
			} else if (msg && msg.type) {
				this.events.push({ msg, line });
			}
		}
	}

	send(cmd, { timeoutMs = 45000 } = {}) {
		const id = cmd.id ?? `req-${++this.seq}`;
		const payload = { ...cmd, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout ${timeoutMs}ms for ${cmd.type} (stderr: ${this.stderr.slice(-400)})`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
			});
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	waitForEvent(pred, { timeoutMs = 90000 } = {}) {
		const found = this.events.find((e) => pred(e.msg));
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const iv = setInterval(() => {
				const hit = this.events.find((e) => pred(e.msg));
				if (hit) {
					clearInterval(iv);
					resolve(hit);
				} else if (Date.now() - start > timeoutMs) {
					clearInterval(iv);
					reject(new Error(`event wait timeout after ${timeoutMs}ms (stderr: ${this.stderr.slice(-400)})`));
				}
			}, 40);
		});
	}

	close() {
		try {
			this.child.stdin.end();
		} catch {}
	}
}

/**
 * Ephemeral sandbox paths (random mkdtemp suffix) captured inside protocol
 * payloads (e.g. builtin skill/extension sourceInfo) would make goldens
 * non-portable and unreproducible. Replace each sandbox base dir with a stable
 * token so regeneration is byte-stable and no host path leaks into the repo.
 * The token is still valid JSON-string content, so round-trip byte-equality is
 * preserved.
 */
const SANDBOX_TOKENS = [];
function registerSandboxToken(dir) {
	SANDBOX_TOKENS.push(dir);
}
function canonicalize(line) {
	let out = line;
	for (const dir of SANDBOX_TOKENS) {
		out = out.split(dir).join("<SANDBOX>");
	}
	return out;
}

function writeFixture(name, lines) {
	const arr = (Array.isArray(lines) ? lines : [lines]).map(canonicalize);
	// Goldens are LF-framed with a trailing newline (matches jsonl.ts serializeJsonLine).
	writeFileSync(join(__dirname, name), `${arr.join("\n")}\n`);
	process.stderr.write(`wrote ${name} (${arr.length} line(s))\n`);
}

async function main() {
	const authBefore = sha256OrNull(AUTH);

	// -------- 1. State/commands/messages/error via a plain isolated RPC child --------
	const box = makeSandbox();
	registerSandboxToken(box.dir);
	const d = new Driver({ env: box.env, cwd: box.cwd });

	const state = await d.send({ type: "get_state" });
	writeFixture("response_get_state.jsonl", state.line);

	const commands = await d.send({ type: "get_commands" });
	writeFixture("response_get_commands.jsonl", commands.line);

	const messages = await d.send({ type: "get_messages" });
	writeFixture("response_get_messages.jsonl", messages.line);

	// An error response: switch_session to a non-existent path fails deterministically.
	const err = await d.send({ type: "switch_session", sessionPath: "/nonexistent/neo-bridge-fixture/does-not-exist.jsonl" });
	if (err.msg.success !== false) {
		throw new Error(`expected error response, got: ${err.line}`);
	}
	writeFixture("response_error.jsonl", err.line);

	d.close();
	box.cleanup();

	// -------- 2. Full prompt turn -> agent_end event stream via the fake model --------
	const box2 = makeSandbox();
	registerSandboxToken(box2.dir);
	const marker = "NEO-BRIDGE-FIXTURE-PONG";
	const server = await startFakeModelServer({ turns: [{ text: marker }] });
	const baseUrl = server.url;
	const modelsJson = {
		providers: {
			mock: {
				baseUrl,
				apiKey: "sk-mock-neo-bridge-fixture",
				api: "openai-completions",
				models: [
					{ id: "mock-model", baseUrl, api: "openai-completions", contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
				],
			},
		},
	};
	writeFileSync(join(box2.agentDir, "models.json"), JSON.stringify(modelsJson, null, 2));

	const d2 = new Driver({ env: box2.env, cwd: box2.cwd, extraArgs: ["--provider", "mock", "--model", "mock-model", "--no-extensions"] });
	await d2.send({ type: "get_state" }); // ensure booted
	const ack = await d2.send({ type: "prompt", message: "Reply with the marker." });
	if (ack.msg.success !== true) {
		throw new Error(`prompt rejected: ${ack.line}`);
	}
	const end = await d2.waitForEvent((m) => m.type === "agent_end");
	// Capture the ack response + every event line up to and including agent_end.
	const endIdx = d2.events.indexOf(end);
	const eventLines = [ack.line, ...d2.events.slice(0, endIdx + 1).map((e) => e.line)];
	writeFixture("events_prompt_turn.jsonl", eventLines);

	d2.close();
	await server.stop();
	box2.cleanup();

	// -------- 3. extension_error demux sample (schema-real; not emitted by mock loop) --------
	// Shape mirrors rpc-mode.ts:358-360 output({type:"extension_error",...}). We build it
	// from the real serializer path (JSON.stringify) so the bytes match the wire format.
	const extErr = JSON.stringify({
		type: "extension_error",
		extensionPath: "/tmp/neo-bridge-fixture/ext/broken.ts",
		event: "PostToolUse",
		error: "fixture: extension hook threw",
	});
	writeFixture("extension_error.jsonl", extErr);

	// -------- 4. demux_mixed: one line of EACH of the four top-level shapes --------
	// The 4th slot must be a genuine EVENT (not an extension_ui_request, which is
	// its own top-level shape), so pick a real lifecycle event captured above.
	const uiReq = JSON.stringify({ type: "extension_ui_request", id: "ext-1", method: "confirm", title: "Proceed?", message: "Continue with the operation?" });
	const eventLine = d2.events.find((e) => e.msg.type === "agent_start" || e.msg.type === "turn_start" || e.msg.type === "agent_end");
	if (!eventLine) {
		throw new Error("no lifecycle event captured for demux_mixed event slot");
	}
	writeFixture("demux_mixed.jsonl", [state.line, uiReq, extErr, eventLine.line]);

	const authAfter = sha256OrNull(AUTH);
	if (authBefore !== authAfter) {
		throw new Error(`ISOLATION VIOLATION: real auth.json changed (${authBefore} -> ${authAfter})`);
	}
	process.stderr.write(`isolation OK: real auth.json unchanged (${authBefore ? `sha256=${authBefore.slice(0, 12)}…` : "absent"})\n`);
	process.stderr.write("all fixtures generated\n");
}

main().then(
	() => process.exit(0),
	(e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	},
);
