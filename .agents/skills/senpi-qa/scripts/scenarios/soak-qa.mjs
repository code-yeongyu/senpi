#!/usr/bin/env node
// QA.soak (plan §1.3, §3.4 SC-SOAK, QX4; producer P0-05h): N concurrent sessions on the fake model in today's fused
// engine (one multi-session socket host), run in waves, sampled every minute, then judged against B0's bands.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/soak-qa.mjs --placement fused --sessions <X4 cap> --hours <4|8> \
//     --baseline <soak-baseline.json> [--write-baseline] --evidence <slug> [--child binary:<path>]
//
// Each session loops one scripted prompt: two parallel reads, an eval cell (a bash, then a background bash in a PTY
// that the cell closes), and an MCP call. Every wave (10 min) all sessions finish their turn, the older half closes, the
// counters are read at rest (the post-wave level), and as many new sessions open. `--write-baseline` records B0: it
// writes the bands to --baseline (never over an existing file). Without it the run is checked against those bands.
// Smoke overrides for a short local proof (`--minutes`, `--wave-minutes`, `--sample-seconds`, `--window-minutes`)
// mark the receipt `smoke: true`. Exit 0 only when the workload ran clean and, when comparing, every budget held.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	childRuntime,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	resolveBun,
	spawnCli,
} from "../lib/common.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { soakOwner } from "../lib/owner-receipt.mjs";
import {
	buildBands,
	checkBudgets,
	descendants,
	latencyByWindow,
	POST_WAVE_COUNTERS,
	readProcessTable,
	sampleProcessTree,
} from "../lib/resource-sampler.mjs";
import { RpcClient } from "../lib/rpc-client.mjs";
import { writeCodemodeSettings } from "../../scenarios/fused-equivalence/cases/support/codemode.mjs";

// ---------------------------------------------------------------------------
// Fake model
// ---------------------------------------------------------------------------

// The fake model: an OpenAI-completions endpoint that scripts every soak turn from the request itself, so any number
// of concurrent sessions can share it. The scripted fake-model-server.mjs answers one global turn sequence; a soak has N
// sessions at different points of their loops, so each answer is derived from the conversation the request carries: how
// many assistant messages follow the latest soak prompt.

/** The tool the stdio MCP fixture exposes (packages/coding-agent/test/mcp/fixtures/stdio-server.ts `--tools 1`). */
export const SOAK_MCP_TOOL = "mcp_fxsoak_tool_1";

/** One eval cell: a foreground bash, then a background bash (a PTY) that the same cell closes with kill_bash. */
const EVAL_CELL = [
	'const fg = await tool.bash({ command: "echo soak-bash" });',
	"print(fg.text);",
	'const bg = await tool.bash({ command: "sleep 600", run_in_background: true });',
	"const killed = await tool.kill_bash({ bash_id: bg.details.bash_id });",
	"print(killed.text);",
].join("\n");

/**
 * The loop one prompt runs: step 0 two parallel reads, step 1 the eval cell (bash + PTY), step 2 an MCP call, then
 * the closing text. `step` counts the assistant messages after the latest soak prompt.
 */
export function soakStep(step, idPrefix) {
	const call = (n, name, args) => ({ id: `${idPrefix}_${n}`, name, args });
	if (step === 0) return { toolCalls: [call(0, "read", { path: "a.txt" }), call(1, "read", { path: "b.txt" })] };
	if (step === 1)
		return { toolCalls: [call(0, "eval", { language: "js", summary: "soak bash and pty", code: EVAL_CELL })] };
	if (step === 2) return { toolCalls: [call(0, SOAK_MCP_TOOL, { value: "soak" })] };
	return { text: "SOAK-TURN-DONE" };
}

/** The prompt the soak driver sends; each turn's step count starts at the latest message carrying it. */
const SOAK_PROMPT_PREFIX = "soak turn ";

const textOf = (content) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
			: "";

/**
 * The step a chat-completions request is at, and a call-id prefix unique within its conversation. The anchor is the
 * latest user message carrying the driver's prompt, not the latest user message: the engine also sends user-role
 * messages of its own mid-turn (a background terminal's exit notice after the eval cell closes its PTY).
 */
export function stepOf(messages) {
	const list = Array.isArray(messages) ? messages : [];
	let anchor = -1;
	for (let i = 0; i < list.length; i++)
		if (list[i]?.role === "user" && textOf(list[i].content).includes(SOAK_PROMPT_PREFIX)) anchor = i;
	const step = list.slice(anchor + 1).filter((message) => message?.role === "assistant").length;
	return { step, idPrefix: `s${list.length}` };
}

function writeSse(res, turn, model) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const base = { id: "chatcmpl-soak", object: "chat.completion.chunk", created: 0, model };
	const send = (delta, finish = null) =>
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	send({ role: "assistant", content: "" });
	const toolCalls = (turn.toolCalls ?? []).map((tc, index) => ({
		index,
		id: tc.id,
		type: "function",
		function: { name: tc.name, arguments: JSON.stringify(tc.args) },
	}));
	if (turn.text) send({ content: turn.text });
	if (toolCalls.length) send({ tool_calls: toolCalls });
	send({}, toolCalls.length ? "tool_calls" : "stop");
	res.write(
		`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
	);
	res.end("data: [DONE]\n\n");
}

/** Start the soak model on 127.0.0.1. `requests` counts answered model calls. */
function startSoakModel() {
	const stats = { requests: 0 };
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			if (req.method === "GET" && req.url?.includes("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				return void res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
			}
			if (!req.url?.includes("/chat/completions")) {
				res.writeHead(404, { "content-type": "application/json" });
				return void res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${req.url}` } }));
			}
			let body = {};
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			} catch {}
			stats.requests++;
			const { step, idPrefix } = stepOf(body.messages);
			writeSse(res, soakStep(step, idPrefix), body.model ?? "mock-model");
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const origin = `http://127.0.0.1:${server.address().port}`;
			resolve({
				url: `${origin}/v1`,
				origin,
				stats,
				stop: () => {
					server.closeAllConnections?.();
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

// The host: today's fused engine as one multi-session socket host (`--mode rpc --multi-session --listen`, in-process
// session runtime, the socket host's default) on the driver's child runtime, with the soak's sandbox, fake model and MCP
// fixture. Also the receipt facts that name what ran: the X4 cap, `soak.deps` and the machine class.

const READY_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 30_000;

/** The stdio MCP fixture every soak session connects to; its path marks MCP server processes in the tree. */
const mcpFixture = () => join(repoRoot(), "packages", "coding-agent", "test", "mcp", "fixtures", "stdio-server.ts");

/** X4 (the worker cap) as today's source defines it: `SESSION_WORKER_LIMITS.workers`. */
function x4Cap() {
	const source = readFileSync(
		join(repoRoot(), "packages", "coding-agent", "src", "modes", "rpc", "session-worker-protocol.ts"),
		"utf8",
	);
	const match = /SESSION_WORKER_LIMITS = \{\s*workers: (\d+),/.exec(source);
	if (!match) throw new Error("soak: SESSION_WORKER_LIMITS.workers not found in session-worker-protocol.ts");
	return Number(match[1]);
}

function git(args) {
	try {
		return execFileSync("git", args, {
			cwd: repoRoot(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/** `soak.deps`: the engine that ran (version + head, or the binary's sha256) and the repository head it ran from. */
function soakDeps() {
	const runtime = childRuntime();
	const head = git(["rev-parse", "HEAD"]) ?? process.env.SOAK_SOURCE_COMMIT ?? null;
	const dirty = (git(["status", "--porcelain"]) ?? "") !== "";
	const version = JSON.parse(
		readFileSync(join(repoRoot(), "packages", "coding-agent", "package.json"), "utf8"),
	).version;
	const engine =
		runtime.kind === "binary"
			? `binary:sha256:${createHash("sha256").update(readFileSync(runtime.command)).digest("hex")}`
			: `senpi@${version}+${head}${dirty ? "-dirty" : ""}`;
	return { engine, host_heads: { senpi: head } };
}

/** The machine class a receipt records: platform, CPU model, cores and memory, never a host name. */
function machineClass() {
	const cpu = os.cpus()[0]?.model?.trim() ?? "unknown-cpu";
	return `${process.platform}-${process.arch}/${cpu}/${os.availableParallelism()}c/${Math.round(os.totalmem() / 2 ** 30)}GB`;
}

/** Sandbox, model and MCP configuration, the host child, and a stop() that reports processes left behind. */
async function startSoakHost(model) {
	const box = makeSandbox("soak");
	writeMockModelsJson(box.agentDir, model, "openai-completions");
	writeFileSync(join(box.cwd, "a.txt"), "alpha\n");
	writeFileSync(join(box.cwd, "b.txt"), "bravo\n");
	const mcp = { mcpServers: { fxsoak: { command: resolveBun().command, args: [mcpFixture(), "--tools", "1"] } } };
	writeFileSync(join(box.agentDir, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);
	writeCodemodeSettings(box.cwd, {});
	// SENPI_MEMORY_REPORT=1 turns on the host's own on-demand memory report (main heap, kernel listing); it is read by
	// the sampler and changes nothing the sessions do.
	const env = { ...hermeticEnv(box.env), SENPI_MEMORY_REPORT: "1" };
	// macOS caps a Unix socket path at 103 bytes; only when the task's TMPDIR is too deep for that does the socket (and
	// nothing else) move to /tmp.
	const shortEnough = join(os.tmpdir(), "soak-XXXXXX", "host.sock").length <= 103;
	const socketDir = mkdtempSync(join(shortEnough ? os.tmpdir() : "/tmp", "soak-"));
	const socket = join(socketDir, "host.sock");
	const args = ["--mode", "rpc", "--multi-session", "--listen", socket, "--session-runtime", "in-process"];
	const child = spawnCli(
		[...args, "--provider", "mock", "--model", "mock-model", "--no-skills", "--no-context-files"],
		{
			env,
			cwd: box.cwd,
		},
	);
	let stderr = "";
	await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`soak host not listening: ${stderr.slice(-800)}`)),
			READY_TIMEOUT_MS,
		);
		child.stderr.on("data", (data) => {
			stderr += data.toString();
			if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
			if (stderr.includes("senpi rpc listening on")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("close", (code) => reject(new Error(`soak host exited ${code}: ${stderr.slice(-800)}`)));
	});
	return {
		box,
		env,
		socket,
		pid: child.pid,
		stderr: () => stderr,
		async stop() {
			if (child.exitCode === null && child.signalCode === null) {
				const closed = new Promise((resolve) => child.once("close", resolve));
				child.kill("SIGTERM");
				const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
				await closed;
				clearTimeout(timer);
			}
			rmSync(socketDir, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

// One session: its own client connection to the multi-session host (the shipped socket transport, through
// rpc-client.mjs's attach bridge), a turn loop, and per-call latency taken from the tool events the host delivers. Every
// event is stamped when it arrives, so a call's latency is the time between its `tool_execution_start` and
// `tool_execution_end` as a client sees them.

const OPEN_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 60_000;

class StampedRpcClient extends RpcClient {
	_onData(chunk) {
		const before = this.events.length;
		super._onData(chunk);
		const now = Date.now();
		for (let i = before; i < this.events.length; i++) this.events[i].receivedAt = now;
	}
}

function exited(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("close", () => resolve()));
}

class SoakSession {
	/** @param {{ socket: string, env: object, cwd: string, onCall: (call: object) => void }} options */
	constructor({ socket, env, cwd, onCall }) {
		this.cwd = cwd;
		this.onCall = onCall;
		this.client = new StampedRpcClient({ attach: socket, env, cwd });
		this.sessionId = undefined;
		this.turns = 0;
		this.errors = [];
	}

	async request(command, timeoutMs = COMMAND_TIMEOUT_MS) {
		const response = await this.client.send({ ...command, sessionId: this.sessionId }, { timeoutMs });
		if (!response.success) throw new Error(`${command.type} failed: ${JSON.stringify(response).slice(0, 400)}`);
		return response;
	}

	async open() {
		const opened = await this.client.send({ type: "open_session", cwd: this.cwd }, { timeoutMs: OPEN_TIMEOUT_MS });
		if (!opened.success) throw new Error(`open_session failed: ${JSON.stringify(opened).slice(0, 400)}`);
		this.sessionId = opened.data.sessionId;
	}

	/** One prompt through the whole scripted loop; resolves when the host reports the session settled. */
	async turn() {
		const settled = this.client.waitForEvent(
			(event) => event.type === "agent_settled" && event.sessionId === this.sessionId,
			{ timeoutMs: TURN_TIMEOUT_MS },
		);
		settled.catch(() => {});
		await this.request({ type: "prompt", message: `${SOAK_PROMPT_PREFIX}${this.turns + 1}` });
		await settled;
		const starts = new Map();
		for (const event of this.client.events) {
			if (event.sessionId !== this.sessionId) continue;
			if (event.type === "tool_execution_start") starts.set(event.toolCallId, event.receivedAt);
			if (event.type !== "tool_execution_end" || !starts.has(event.toolCallId)) continue;
			const call = {
				t: event.receivedAt,
				ms: event.receivedAt - starts.get(event.toolCallId),
				tool: event.toolName,
			};
			this.onCall(call);
			if (event.isError)
				this.errors.push(`${event.toolName} returned an error: ${JSON.stringify(event.result).slice(0, 300)}`);
		}
		// Each turn's events are consumed here; dropping them keeps a multi-hour client's memory flat.
		this.client.events.length = 0;
		this.client.responses.length = 0;
		this.turns++;
	}

	/** Run turns until `keepGoing()` is false; a failed turn ends this session's loop and is kept in `errors`. */
	async loop(keepGoing) {
		while (keepGoing() && this.errors.length === 0) {
			try {
				await this.turn();
			} catch (error) {
				this.errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	}

	/** The host's on-demand memory report (SENPI_MEMORY_REPORT=1): main-thread heap and the live kernel listing. */
	async memoryReport() {
		const response = await this.request({ type: "memory_report" });
		const report = JSON.parse(readFileSync(response.data.path, "utf8"));
		return { heapBytes: report.main.jscHeapSize ?? report.main.heapUsed, kernels: report.kernels.length };
	}

	async close() {
		await this.request({ type: "close_session" });
		this.client.close();
		await exited(this.client.child);
	}
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const SETTLE_BUDGET_MS = 30_000;
const argv = process.argv.slice(2);
const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const number = (flag) => (value(flag) === undefined ? undefined : Number(value(flag)));

function refuse(message) {
	process.stderr.write(`soak-qa: ${message}\n`);
	process.exit(2);
}

function options() {
	const placement = value("--placement");
	if (placement !== "fused")
		refuse(`--placement ${placement}: only fused exists today (split from P4, split-remote from P5, hosted from P6)`);
	if (childRuntime().kind === "node") refuse("a soak receipt whose CLI child ran on Node is VOID (rule 3.3.10)");
	const sessions = number("--sessions");
	if (!Number.isInteger(sessions) || sessions < 2) refuse("--sessions takes an integer of at least 2");
	const smoke = ["--minutes", "--wave-minutes", "--sample-seconds", "--window-minutes"].some((flag) =>
		argv.includes(flag),
	);
	const hours = number("--hours");
	const durationMs = smoke ? number("--minutes") * MINUTE : hours * 60 * MINUTE;
	if (!(durationMs > 0)) refuse(smoke ? "a smoke run takes --minutes" : "--hours takes a positive number");
	const baseline = value("--baseline") ?? refuse("--baseline <file> is required");
	const writeBaseline = argv.includes("--write-baseline");
	if (writeBaseline && existsSync(baseline)) refuse(`${baseline} exists; a recorded B0 is never overwritten`);
	if (!writeBaseline && !existsSync(baseline)) refuse(`${baseline} does not exist; record B0 with --write-baseline`);
	return {
		placement,
		sessions,
		hours: durationMs / (60 * MINUTE),
		durationMs,
		waveMs: (number("--wave-minutes") ?? 10) * MINUTE,
		sampleMs: (number("--sample-seconds") ?? 60) * 1000,
		windowMs: (number("--window-minutes") ?? 60) * MINUTE,
		baseline,
		writeBaseline,
		smoke,
		slug: value("--evidence") ?? refuse("--evidence <slug> is required"),
	};
}

async function main() {
	installCleanupHooks();
	const opts = options();
	const guard = guardRealAuth();
	const out = evidenceDir(opts.slug);
	const model = await startSoakModel();
	const host = await startSoakHost(model);
	const summary = {
		startMs: Date.now(),
		warmupEndMs: Infinity,
		windowMs: opts.windowMs,
		samples: [],
		postWave: [],
		calls: [],
	};
	const workloadErrors = [];
	const open = async () => {
		const session = new SoakSession({
			socket: host.socket,
			env: host.env,
			cwd: host.box.cwd,
			onCall: (call) => summary.calls.push(call),
		});
		await session.open();
		return session;
	};
	const reading = async (live) => {
		const tree = await sampleProcessTree(host.pid, { mcpMarker: mcpFixture() });
		// The newest session survives the next wave, so a report never races that session's close.
		const memory = await live.at(-1).memoryReport();
		return {
			t: Date.now(),
			...tree,
			heapMb: memory.heapBytes / 2 ** 20,
			kernels: memory.kernels,
			sessions: live.length,
		};
	};
	// One open at a time: an open loads the session's extensions on the host loop, and a client connecting meanwhile can
	// miss its authentication deadline. Replacement opens below run the same way, while the surviving half is at rest.
	const openMany = async (count) => {
		const opened = [];
		for (let i = 0; i < count; i++) opened.push(await open());
		return opened;
	};
	let live = await openMany(opts.sessions);
	let running = true;
	const start = () => live.map((session) => session.loop(() => running));
	let loops = start();
	let sampling = Promise.resolve();
	let paused = false;
	const sampler = setInterval(() => {
		if (paused) return;
		sampling = sampling
			.then(async () => summary.samples.push(await reading(live)))
			.catch((error) => workloadErrors.push(`sample: ${error.message}`));
	}, opts.sampleMs);
	const endMs = summary.startMs + opts.durationMs;
	try {
		for (let wave = 1; summary.startMs + wave * opts.waveMs <= endMs; wave++) {
			await sleep(Math.max(0, summary.startMs + wave * opts.waveMs - Date.now()));
			running = false;
			paused = true;
			await Promise.all(loops);
			await sampling;
			const closing = live.slice(0, Math.floor(live.length / 2));
			for (const session of closing)
				workloadErrors.push(...session.errors.map((error) => `session ${session.sessionId}: ${error}`));
			await Promise.all(closing.map((session) => session.close()));
			live = live.slice(closing.length);
			// At rest the counters only fall while closed sessions' processes exit; read until two readings agree.
			const settleStart = Date.now();
			let level = await reading(live);
			for (;;) {
				const next = await reading(live);
				const same = POST_WAVE_COUNTERS.every((counter) => next[counter] === level[counter]);
				level = next;
				if (same || Date.now() - settleStart > SETTLE_BUDGET_MS) break;
				await sleep(1000);
			}
			summary.postWave.push({ wave, ...level, settleMs: Date.now() - settleStart });
			process.stdout.write(
				`wave ${wave}: ${POST_WAVE_COUNTERS.map((c) => `${c}=${level[c]}`).join(" ")} rssMb=${level.rssMb.toFixed(0)} heapMb=${level.heapMb.toFixed(0)} calls=${summary.calls.length}\n`,
			);
			if (wave === 1) summary.warmupEndMs = Date.now();
			live = [...live, ...(await openMany(closing.length))];
			running = true;
			paused = false;
			loops = start();
		}
		await sleep(Math.max(0, endMs - Date.now()));
	} finally {
		running = false;
		paused = true;
		clearInterval(sampler);
		await Promise.allSettled(loops);
		await sampling;
	}
	for (const session of live)
		workloadErrors.push(...session.errors.map((error) => `session ${session.sessionId}: ${error}`));
	const turns = live.reduce((sum, session) => sum + session.turns, 0);
	await Promise.allSettled(live.map((session) => session.close()));
	const tree = descendants(await readProcessTable(), host.pid).map((row) => row.pid);
	await host.stop();
	const leftBehind = (await readProcessTable()).filter((row) => tree.includes(row.pid)).length;
	await model.stop();
	writeFileSync(join(out, "host.stderr.log"), host.stderr());
	host.box.cleanup();
	guard.assertUnchanged();
	return report(opts, out, summary, { workloadErrors, turns, leftBehind, modelRequests: model.stats.requests });
}

function report(opts, out, summary, facts) {
	writeFileSync(join(out, "samples.jsonl"), `${summary.samples.map((s) => JSON.stringify(s)).join("\n")}\n`);
	writeFileSync(join(out, "post-wave.json"), `${JSON.stringify(summary.postWave, null, 1)}\n`);
	const latency = latencyByWindow(summary.calls, summary.windowMs, summary.startMs);
	writeFileSync(join(out, "latency-windows.json"), `${JSON.stringify(latency, null, 1)}\n`);
	const valid = facts.workloadErrors.length === 0 && summary.postWave.length > 0;
	// B0 is written only from a clean run. A compare run is judged against B0 whenever a wave completed, so a breach is
	// named even when the workload also failed; the run passes only when the workload was clean as well.
	let verdict;
	if (valid && opts.writeBaseline) verdict = checkBudgets(summary, buildBands(summary), { placement: opts.placement });
	else if (!opts.writeBaseline && summary.postWave.length > 0)
		verdict = checkBudgets(summary, JSON.parse(readFileSync(opts.baseline, "utf8")).bands, {
			placement: opts.placement,
		});
	const soak = {
		placement: opts.placement,
		sessions: opts.sessions,
		hours: opts.hours,
		machine_class: machineClass(),
		deps: soakDeps(),
		reused_from: "",
		post_wave_levels_ok: verdict?.post_wave_levels_ok ?? false,
		slopes_in_band: verdict?.slopes_in_band ?? false,
		latency_in_band: verdict?.latency_in_band ?? false,
	};
	const pass = valid && soak.post_wave_levels_ok && soak.slopes_in_band && soak.latency_in_band;
	const run = { argv: ["node", ".agents/skills/senpi-qa/scripts/scenarios/soak-qa.mjs", ...argv], exit: pass ? 0 : 1 };
	const owner = soakOwner({
		writeBaseline: opts.writeBaseline,
		smoke: opts.smoke,
		argv: run.argv,
		childRuntime: childRuntime().label,
		exit: run.exit,
	});
	const receipt = {
		manifest_id: owner.manifestId,
		commands: owner.commands,
		kind: "soak",
		argv: run.argv,
		child_runtime: childRuntime().label,
		mode: opts.writeBaseline ? "b0" : "compare",
		smoke: opts.smoke,
		x4_cap: x4Cap(),
		soak,
		waves: summary.postWave.length,
		turns: facts.turns,
		calls: summary.calls.length,
		model_requests: facts.modelRequests,
		processes_left_after_stop: facts.leftBehind,
		workload_errors: facts.workloadErrors.slice(0, 50),
		violations: verdict?.violations ?? [],
	};
	if (valid && opts.writeBaseline)
		writeFileSync(
			opts.baseline,
			`${JSON.stringify({ recorded: { ...receipt, soak: { ...soak } }, bands: buildBands(summary) }, null, 1)}\n`,
		);
	writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 1)}\n`);
	for (const violation of receipt.violations)
		process.stdout.write(`[BREACH] ${violation.check}: ${violation.detail}\n`);
	for (const error of receipt.workload_errors) process.stdout.write(`[WORKLOAD] ${error}\n`);
	process.stdout.write(
		`soak-qa ${receipt.mode}: ${pass ? "PASS" : "FAIL"} waves=${receipt.waves} turns=${receipt.turns} calls=${receipt.calls} post_wave_levels_ok=${soak.post_wave_levels_ok} slopes_in_band=${soak.slopes_in_band} latency_in_band=${soak.latency_in_band} (child_runtime=${receipt.child_runtime}, x4_cap=${receipt.x4_cap})\nevidence: ${out}\n`,
	);
	process.exitCode = run.exit;
}

// Run only as a script; resource-sampler.test.mjs imports the fake model's script from this file.
const invokedAsScript =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedAsScript)
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		// The exit hook (installCleanupHooks) reaps the host and every bridge this driver spawned.
		process.exit(2);
	});
