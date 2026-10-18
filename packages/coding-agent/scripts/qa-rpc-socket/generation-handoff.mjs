#!/usr/bin/env node
/**
 * Live QA for the generation handoff: two real supervisors, one public socket, one retained
 * session mid-turn.
 *
 * Runs entirely inside a sandbox agent directory, drives the PRODUCTION `ensureHost` /
 * `handoffHost` / `stopHost` entry points against the source lifecycle supervisor, and prints one
 * JSON line per step so the evidence file can quote observations rather than claims.
 *
 * Usage: node scripts/qa-rpc-socket/generation-handoff.mjs [--keep]
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostDaemonPaths } from "../../src/modes/rpc/host-daemon-paths.ts";
import { readHostRegistration } from "../../src/modes/rpc/host-daemon-registration.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
const { ensureHost } = await import(join(packageRoot, "src/modes/rpc/host-ensure.ts"));
const { handoffHost } = await import(join(packageRoot, "src/modes/rpc/host-handoff.ts"));
const { stopHost } = await import(join(packageRoot, "src/modes/rpc/host-stop.ts"));
const { probeHost } = await import(join(packageRoot, "src/modes/rpc/host-probe.ts"));

const keep = process.argv.includes("--keep");
const root = mkdtempSync(join(tmpdir(), "dh-qa-"));
const agentDir = join(root, "a");
const sessionDir = join(root, "s");
const cwd = join(root, "w");
for (const dir of [agentDir, sessionDir, cwd]) mkdirSync(dir, { recursive: true });
const socket = join(root, "rpc.sock");
const hostArgs = ["--provider", "anthropic", "--model", "mock-claude-rpc"];
const entry = join(packageRoot, "src/modes/rpc/host-lifecycle.ts");
const launch = (args) => ({ command: process.execPath, args: [entry, ...args] });
// Synchronous stdout: a step that hangs must still have printed every step before it.
const say = (step, data) => writeFileSync(1, `${JSON.stringify({ step, ...data })}\n`);

const model = await heldModel();
writeModels(agentDir, model.origin);

const env = {
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
	SENPI_RUNTIME: "node",
	SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
	ANTHROPIC_API_KEY: "sk-ant-rpc-test",
};

try {
	const first = await ensureHost({
		socket,
		agentDir,
		policy: { idleExitMs: 600_000 },
		hostArgs,
		env,
		_test: { readinessTimeoutMs: 60_000, launch },
	});
	const before = await probeHost({ socket });
	first.release();
	say("ensure", { pid: first.pid, reused: first.reused, instanceId: before.instanceId, generation: before.generation });

	const sessionPath = join(sessionDir, "qa.jsonl");
	const holder = await connect(socket);
	const opened = await holder.request({ id: "open", type: "open_session", cwd, sessionPath, retain_on_disconnect: true });
	const sessionId = opened.data.sessionId;
	const watcher = await connect(socket);
	const started = holder.waitFor((value) => value.type === "agent_start" && value.sessionId === sessionId);
	await holder.request({ id: "prompt", type: "prompt", sessionId, message: "hold this turn open" });
	await started;
	say("session", { sessionId, sessionPath, inode: statSync(socket).ino });
	holder.destroy();

	process.on("beforeExit", (code) => writeFileSync(1, `${JSON.stringify({ step: "beforeExit", code })}\n`));
	const result = await handoffHost({ socket, agentDir, hostArgs, env, _test: { launch, readinessTimeoutMs: 60_000 } });
	const after = await probeHost({ socket });
	say("handoff", {
		action: result.action,
		pid: result.pid ?? null,
		reason: result.reason ?? null,
		instanceId: after?.instanceId,
		generation: after?.generation,
		inode: statSync(socket).ino,
		pidfile: (await readHostRegistration(createHostDaemonPaths({ socket, agentDir }))).record,
	});

	const next = await connect(socket);
	const refused = await next.request({ id: "reopen", type: "open_session", cwd, sessionPath });
	say("reopen-while-held", { error: refused.error, errorData: refused.errorData });

	const parked = watcher.waitFor((value) => value.type === "session_closed");
	model.release();
	say("parked", await parked);
	await watcher.waitForClose(60_000);
	for (let attempt = 0; attempt < 300 && alive(first.pid); attempt++) await delay(100);
	say("old-generation-gone", { pid: first.pid, alive: alive(first.pid) });

	const reopened = await next.request({ id: "reopen-2", type: "open_session", cwd, sessionPath });
	const lines = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);
	say("reopened", {
		success: reopened.success,
		attached: reopened.data?.attached ?? false,
		lines: lines.length,
		everyLineParses: lines.every((line) => {
			try {
				JSON.parse(line);
				return true;
			} catch {
				return false;
			}
		}),
	});
	next.destroy();

	const drained = await stopHost({ socket, agentDir, drain: true });
	say("drain", drained);
	for (let attempt = 0; attempt < 600 && alive(result.pid); attempt++) await delay(100);
	say("drained-generation-gone", { pid: result.pid, alive: alive(result.pid) });
} catch (cause) {
	say("failed", { error: cause instanceof Error ? cause.stack : String(cause) });
	process.exitCode = 1;
} finally {
	// Release first: closing a server with a held request in flight never completes.
	model.release();
	await model.close();
	if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	say("sandbox", {
		root,
		kept: keep,
		stderr: keep ? createHostDaemonPaths({ socket, agentDir }).stderrLog : null,
	});
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeModels(dir, origin) {
	const models = {
		providers: {
			anthropic: {
				baseUrl: origin,
				apiKey: "sk-ant-rpc-test",
				api: "anthropic-messages",
				models: [
					{
						id: "mock-claude-rpc",
						baseUrl: origin,
						api: "anthropic-messages",
						reasoning: true,
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
	writeFileSync(join(dir, "models.json"), `${JSON.stringify(models, null, 2)}\n`);
}

async function heldModel() {
	let release = () => {};
	const held = new Promise((resolve) => {
		release = resolve;
	});
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => void held.then(() => answer(res)));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		release,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

function answer(res) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	send("message_start", {
		message: {
			id: "msg-qa",
			type: "message",
			role: "assistant",
			model: "mock-claude-rpc",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	});
	send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "held turn complete" } });
	send("content_block_stop", { index: 0 });
	send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
	send("message_stop", {});
	res.end();
}

async function connect(path) {
	const socket = createConnection(path);
	await new Promise((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const messages = [];
	const waiters = new Set();
	let buffer = "";
	let closed = false;
	const closeWaiters = new Set();
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			messages.push(message);
			for (const waiter of [...waiters]) {
				if (!waiter.predicate(message)) continue;
				waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
	});
	socket.once("close", () => {
		closed = true;
		for (const resolve of closeWaiters) resolve();
		closeWaiters.clear();
	});
	const waitFor = (predicate, timeoutMs = 60_000) => {
		const existing = messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = { predicate, resolve };
			waiters.add(waiter);
			setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error("timed out waiting for a record"));
			}, timeoutMs).unref();
		});
	};
	return {
		request(command, timeoutMs) {
			const response = waitFor((value) => value.type === "response" && value.id === command.id, timeoutMs);
			socket.write(`${JSON.stringify(command)}\n`);
			return response;
		},
		waitFor,
		waitForClose(timeoutMs = 60_000) {
			if (closed) return Promise.resolve();
			return new Promise((resolve, reject) => {
				closeWaiters.add(resolve);
				setTimeout(() => reject(new Error("connection stayed open")), timeoutMs).unref();
			});
		},
		destroy: () => socket.destroy(),
	};
}
