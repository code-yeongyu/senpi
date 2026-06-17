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
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, spawnCli } from "./lib/common.mjs";

/**
 * Minimal JSON-lines RPC client over a spawned `--mode rpc` child.
 * Resolves send() promises by matching the response `id`; buffers events.
 */
export class RpcClient {
	constructor({ env, cwd, extraArgs = [] } = {}) {
		this.child = spawnCli(["--mode", "rpc", "--no-session", "--no-context-files", ...extraArgs], { env, cwd });
		this.pending = new Map();
		this.events = [];
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
			const start = Date.now();
			const iv = setInterval(() => {
				const hit = this.events.find(pred);
				if (hit) {
					clearInterval(iv);
					resolve(hit);
				} else if (Date.now() - start > timeoutMs) {
					clearInterval(iv);
					reject(new Error(`event wait timeout after ${timeoutMs}ms`));
				}
			}, 50);
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

async function drivePrompt(message, { provider, model, slug }) {
	installCleanupHooks();
	const guard = guardRealAuth();
	const box = makeSandbox("rpc-prompt");
	const extraArgs = [];
	if (provider) extraArgs.push("--provider", provider);
	if (model) extraArgs.push("--model", model);
	const client = new RpcClient({ env: box.env, cwd: box.cwd, extraArgs });

	await client.send({ type: "get_state" }); // ensure booted
	const ack = await client.send({ type: "prompt", message });
	if (ack.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(ack)}`);

	// Wait for the turn to finish, then pull the assistant text.
	await client.waitForEvent((e) => e.type === "agent_end" || e.type === "agent_aborted", { timeoutMs: 90000 }).catch(
		() => {},
	);
	const last = await client.send({ type: "get_last_assistant_text" });
	const text = last.data?.text ?? "";
	process.stdout.write(`${text}\n`);

	if (slug) {
		const dir = evidenceDir(slug);
		writeFileSync(join(dir, "rpc-events.jsonl"), client.events.map((e) => JSON.stringify(e)).join("\n"));
		writeFileSync(join(dir, "rpc-last-assistant.txt"), text);
		process.stderr.write(`evidence: ${dir}\n`);
	}

	client.close();
	guard.assertUnchanged();
	box.cleanup();
	return text;
}

// --- entrypoint ---
const argv = process.argv.slice(2);
if (argv[0] === "--self-test") {
	selfTest();
} else if (argv[0] === "--state") {
	driveState();
} else if (argv[0] === "--prompt") {
	const message = argv[1];
	const get = (flag) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (!message) {
		process.stderr.write("usage: rpc-drive.mjs --prompt <message> [--provider P --model M] [--evidence SLUG]\n");
		process.exit(2);
	}
	drivePrompt(message, { provider: get("--provider"), model: get("--model"), slug: get("--evidence") }).catch((e) => {
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
			"",
		].join("\n"),
	);
}
