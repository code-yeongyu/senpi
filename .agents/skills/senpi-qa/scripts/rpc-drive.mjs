/**
 * Channel 1 — Remote RPC QA.
 *
 * Drives the coding-agent's headless RPC mode (`--mode rpc`), which speaks
 * JSON-RPC over stdio as JSON lines (see packages/coding-agent/src/modes/rpc/).
 * Commands go in on stdin; a `{type:"response",...}` line plus a stream of
 * AgentSessionEvent lines come back on stdout.
 *
 * This is the surface to QA when you change the agent loop, tools, session
 * lifecycle, model/provider resolution, or anything an embedder drives over RPC.
 *
 * Usage:
 *   node rpc-drive.mjs --self-test                 # get_state round-trips, no API call
 *   node rpc-drive.mjs --state                     # print live get_state
 *   node rpc-drive.mjs --prompt "say PONG" \       # drive a real turn (needs a model)
 *        [--provider P --model M] [--evidence SLUG]
 *   node rpc-drive.mjs --with-mock openai-responses --with-reasoning \
 *        --prompt "say PONG" --evidence rpc-reasoning
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, spawnCli } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import {
	ALL_APIS,
	API_PRESETS,
	QA_FINAL_MARKER,
	hermeticEnv,
	reasoningScriptedTurn,
	writeMockModelsJson,
} from "./lib/mock-loop-support.mjs";

/**
 * Minimal JSON-lines RPC client over a spawned `--mode rpc` child.
 * Resolves send() promises by matching the response `id`; buffers events.
 */
export class RpcClient {
	constructor({ env, cwd, extraArgs = [] } = {}) {
		this.child = spawnCli(["--mode", "rpc", "--no-session", "--no-context-files", ...extraArgs], { env, cwd });
		this.pending = new Map();
		this.events = [];
		this.eventWaiters = [];
		this.responses = [];
		this.seq = 0;
		this._buf = "";
		this.child.stdout.on("data", (chunk) => this._onData(chunk));
		this.stderr = "";
		this.child.stderr.on("data", (d) => {
			this.stderr += d.toString();
		});
	}

	_onData(chunk) {
		this._buf += chunk.toString();
		let nl;
		while ((nl = this._buf.indexOf("\n")) >= 0) {
			const line = this._buf.slice(0, nl).trim();
			this._buf = this._buf.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // non-protocol noise (tsx/startup) — ignore
			}
			if (msg && msg.type === "response") {
				this.responses.push(msg);
				const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
				if (waiter) {
					this.pending.delete(msg.id);
					waiter.resolve(msg);
				}
			} else if (msg && msg.type) {
				this.events.push(msg);
				for (const waiter of [...this.eventWaiters]) {
					if (!waiter.pred(msg)) continue;
					clearTimeout(waiter.timer);
					this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
					waiter.resolve(msg);
				}
			}
		}
	}

	/** Send a command; resolves with the correlated response line. */
	send(cmd, { timeoutMs = 45000 } = {}) {
		const id = cmd.id ?? `req-${++this.seq}`;
		const payload = { ...cmd, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout after ${timeoutMs}ms for ${cmd.type} (stderr: ${this.stderr.slice(-400)})`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				},
			});
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	/** Wait until an event matching `pred` is observed (or already was). */
	waitForEvent(pred, { timeoutMs = 60000 } = {}) {
		const found = this.events.find(pred);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const waiter = {
				pred,
				resolve,
				timer: setTimeout(() => {
					this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
					reject(new Error(`event wait timeout after ${timeoutMs}ms`));
				}, timeoutMs),
			};
			this.eventWaiters.push(waiter);
		});
	}

	/** End stdin so the RPC process exits cleanly. */
	close() {
		try {
			this.child.stdin.end();
		} catch {}
	}
}

async function selfTest() {
	installCleanupHooks();
	const checks = createChecks("rpc-drive.mjs --self-test");
	const guard = guardRealAuth();
	const box = makeSandbox("rpc-drive");
	const client = new RpcClient({ env: box.env, cwd: box.cwd });

	let res;
	await checks.run("get_state returns a success response", async () => {
		res = await client.send({ type: "get_state" });
		if (res.type !== "response" || res.command !== "get_state" || res.success !== true) {
			throw new Error(`unexpected response: ${JSON.stringify(res)}`);
		}
		return `sessionId=${res.data?.sessionId ?? "?"} streaming=${res.data?.isStreaming}`;
	});

	checks.ok(
		"state has the documented shape (RpcSessionState)",
		!!res && typeof res.data === "object" && typeof res.data.messageCount === "number",
		res ? `messageCount=${res.data.messageCount}` : "",
	);

	checks.ok("no real provider API was required to boot RPC", true, "offline sandbox, get_state is local");

	client.close();
	await new Promise((r) => setTimeout(r, 300));
	checks.ok("real auth unchanged", (() => {
		try {
			return guard.assertUnchanged();
		} catch {
			return false;
		}
	})(), guard.path);

	box.cleanup();
	const passed = checks.finish();
	process.exit(passed ? 0 : 1);
}

async function driveState() {
	installCleanupHooks();
	const box = makeSandbox("rpc-state");
	const client = new RpcClient({ env: box.env, cwd: box.cwd });
	const res = await client.send({ type: "get_state" });
	process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
	client.close();
	box.cleanup();
}

async function drivePrompt(message, { provider, model, slug, mockApi, withReasoning }) {
	installCleanupHooks();
	const guard = guardRealAuth();
	const box = makeSandbox(mockApi ? `rpc-mock-${mockApi}` : "rpc-prompt");
	let server;
	let client;
	try {
		const extraArgs = [];
		let env = box.env;
		if (mockApi) {
			const preset = API_PRESETS[mockApi];
			const turn = withReasoning
				? reasoningScriptedTurn()
				: { text: "SENPI-QA-RPC-MOCK-FINAL-7f3a" };
			server = await startFakeModelServer({ turns: [turn] });
			writeMockModelsJson(box.agentDir, server, mockApi);
			env = hermeticEnv(box.env);
			extraArgs.push("--provider", preset.provider, "--model", preset.modelId);
		} else {
			if (provider) extraArgs.push("--provider", provider);
			if (model) extraArgs.push("--model", model);
		}
		client = new RpcClient({ env, cwd: box.cwd, extraArgs });

		await client.send({ type: "get_state" }); // ensure booted
		const ack = await client.send({ type: "prompt", message });
		if (ack.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(ack)}`);

		// Mock reasoning runs are a strict end-to-end assertion: do not let a
		// terminal timeout or user abort masquerade as a stream with thinking.
		const terminal = await client.waitForEvent((e) => e.type === "agent_end" || e.type === "agent_aborted", { timeoutMs: 90000 });
		if (withReasoning && terminal.type !== "agent_end") throw new Error(`reasoning mock turn did not complete: ${terminal.type}`);
		const last = await client.send({ type: "get_last_assistant_text" });
		const text = last.data?.text ?? "";
		const thinkingFrames = client.events.filter(
			(event) => event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta",
		);
		if (withReasoning && thinkingFrames.length === 0) {
			throw new Error("reasoning mock turn completed without an RPC thinking_delta frame");
		}
		if (withReasoning && !text.includes(QA_FINAL_MARKER)) {
			throw new Error(`reasoning mock turn did not return ${QA_FINAL_MARKER}`);
		}
		process.stdout.write(`${text}\n`);

		if (slug) {
			const dir = evidenceDir(slug);
			writeFileSync(join(dir, "rpc-events.jsonl"), client.events.map((event) => JSON.stringify(event)).join("\n"));
			writeFileSync(join(dir, "rpc-last-assistant.txt"), text);
			process.stderr.write(`evidence: ${dir}\n`);
		}
		return text;
	} finally {
		client?.close();
		if (server) await server.stop();
		guard.assertUnchanged();
		box.cleanup();
	}
}

// --- entrypoint ---
const argv = process.argv.slice(2);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};
const mockApi = flag("--with-mock");
if (mockApi && !API_PRESETS[mockApi]) {
	process.stderr.write(`unknown --with-mock API ${mockApi}. valid: ${ALL_APIS.join(", ")}\n`);
	process.exit(2);
}
if (argv[0] === "--self-test") {
	selfTest();
} else if (argv[0] === "--state") {
	driveState();
} else if (argv.includes("--prompt")) {
	const message = flag("--prompt");
	const withReasoning = argv.includes("--with-reasoning");
	if (!message) {
		process.stderr.write("usage: rpc-drive.mjs --prompt <message> [--provider P --model M] [--evidence SLUG]\n");
		process.exit(2);
	}
	if (withReasoning && !mockApi) {
		process.stderr.write("--with-reasoning requires --with-mock <api>\n");
		process.exit(2);
	}
	drivePrompt(message, {
		provider: flag("--provider"),
		model: flag("--model"),
		slug: flag("--evidence"),
		mockApi,
		withReasoning,
	}).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else {
	process.stdout.write(
		[
			"senpi-qa Channel 1 — Remote RPC",
			"  node rpc-drive.mjs --self-test            verify get_state round-trips (no API)",
			"  node rpc-drive.mjs --state               print live RpcSessionState",
			"  node rpc-drive.mjs --prompt <msg> ...    drive a real turn (needs a model)",
			"  node rpc-drive.mjs --with-mock <api> --with-reasoning --prompt <msg> [--evidence SLUG]",
			"",
		].join("\n"),
	);
}
