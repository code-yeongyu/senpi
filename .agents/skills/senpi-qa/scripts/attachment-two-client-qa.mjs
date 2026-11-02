import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { guardRealAuth, installCleanupHooks, makeSandbox, runCli, spawnCli, track } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

// Two command-line client processes use the shipped transport against one real CLI host.
if (process.argv[2] === "--client") {
	const client = new RpcClient({ socketPath: process.argv[3] });
	await client.start();
	const lines = createInterface({ input: client.socket });
	lines.on("line", (line) => process.send({ kind: "wire", record: JSON.parse(line) }));
	process.on("message", async (message) => {
		try {
			if (message.kind === "stop") {
				lines.close();
				await client.stop();
				process.disconnect();
				return;
			}
			const response = await client.send(message.command, false);
			process.send({ kind: "reply", id: message.id, response });
		} catch (error) {
			process.send({ kind: "error", id: message.id, error: String(error) });
		}
	});
	process.send({ kind: "ready" });
} else {
	installCleanupHooks();
	const out = process.argv[2];
	assert(out, "usage: node --import tsx attachment-two-client-qa.mjs <evidence-dir>");
	mkdirSync(out, { recursive: true });
	const guard = guardRealAuth();
	const box = makeSandbox("rpc-attach-two-client");
	const transcript = [];
	const clients = [];
	let stderr = "";
	// macOS caps a Unix socket path at 103 bytes; a deep sandbox root overflows it, so only the socket lives here.
	const socketDir = mkdtempSync("/tmp/aq-");
	const socket = join(socketDir, "host.sock");
	// A local fake model writes the transcript a parked session resumes from; a short idle window parks it.
	const model = await startFakeModelServer({ turns: [{ text: "PARK-QA-OK" }] });
	writeMockModelsJson(box.agentDir, model, "openai-completions");
	const env = { ...hermeticEnv(box.env), SENPI_RPC_SESSION_IDLE_EVICTION_MS: "2000" };
	const host = spawnCli(
		["--mode", "rpc", "--multi-session", "--listen", socket, "--session-runtime", "in-process",
			"--provider", "mock", "--model", "mock-model", "--no-extensions", "--no-skills", "--no-context-files"],
		{ env, cwd: box.cwd },
	);
	const hostExit = once(host, "close");
	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`host readiness deadline: ${stderr}`)), 60_000);
		host.stderr.on("data", (data) => {
			stderr += data.toString();
			if (stderr.includes("senpi rpc listening on")) {
				clearTimeout(timer);
				resolve();
			}
		});
		host.once("error", reject);
	});
	async function connect(name) {
		const child = track(fork(fileURLToPath(import.meta.url), ["--client", socket], {
			cwd: box.cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"],
			execArgv: ["--import", import.meta.resolve("tsx")],
		}));
		const exit = once(child, "close");
		const pending = new Map();
		const records = [];
		const recordWaiters = new Set();
		let serial = 0;
		let readyResolve;
		const started = new Promise((resolve) => { readyResolve = resolve; });
		child.stdout.resume();
		child.stderr.on("data", (data) => { stderr += `${name}: ${data}`; });
		child.on("message", (message) => {
			if (message.kind === "ready") readyResolve();
			if (message.kind === "wire") {
				records.push(message.record);
				transcript.push({ client: name, direction: "receive", record: message.record });
				for (const waiter of recordWaiters) {
					if (!waiter.predicate(message.record)) continue;
					recordWaiters.delete(waiter);
					clearTimeout(waiter.timer);
					waiter.resolve(message.record);
				}
			}
			const waiter = pending.get(message.id);
			if (!waiter) return;
			clearTimeout(waiter.timer);
			pending.delete(message.id);
			if (message.kind === "error") waiter.reject(new Error(message.error));
			else waiter.resolve(message.response);
		});
		const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 60_000);
		try {
			await Promise.race([started, exit.then(() => { throw new Error(`${name} exited before ready`); })]);
		} finally {
			clearTimeout(deadline);
		}
		const client = {
			records,
			waitFor(predicate, what) {
				const seen = records.find(predicate);
				if (seen) return Promise.resolve(seen);
				return new Promise((resolve, reject) => {
					const waiter = { predicate, resolve };
					waiter.timer = setTimeout(() => { recordWaiters.delete(waiter); reject(new Error(`${name} deadline: ${what}`)); }, 60_000);
					recordWaiters.add(waiter);
				});
			},
			send(command) {
				transcript.push({ client: name, direction: "send", command });
				const id = ++serial;
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} request deadline`)); }, 60_000);
					pending.set(id, { resolve, reject, timer });
					child.send({ kind: "request", id, command });
				});
			},
			async stop() {
				if (child.exitCode !== null) return;
				const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
				child.send({ kind: "stop" });
				try { await exit; } finally { clearTimeout(timer); }
			},
		};
		clients.push(client);
		return client;
	}
	try {
		await ready;
		const a = await connect("A");
		const b = await connect("B");
		const protocol = await a.send({ type: "get_protocol_info" });
		assert.equal(protocol.success, true);
		const refs = [];
		for (const client of [a, b]) {
			const opened = await client.send({ type: "open_session", cwd: box.cwd, retain_on_disconnect: true });
			assert.equal(opened.success, true);
			const ref = {
				sessionId: opened.data.sessionId, sessionPath: opened.data.state.sessionFile,
				durableSessionId: opened.data.state.sessionId, expectedHostInstance: protocol.data.instanceId,
			};
			refs.push(ref);
			const attached = await client.send({ type: "attach_session", ...ref });
			assert.deepEqual(attached.data, { sessionId: ref.sessionId, attached: true });
			const released = await client.send({ type: "release_attachment", sessionId: ref.sessionId });
			assert.deepEqual(released.data, { deferred: false });
		}
		const beforeA = a.records.length;
		const beforeB = b.records.length;
		assert.deepEqual((await a.send({ type: "reclaim_session", ...refs[0] })).data,
			{ reclaimed: true, sessionId: refs[0].sessionId });
		const listed = await b.send({ type: "list_sessions" });
		assert.deepEqual(listed.data.sessions.map(({ sessionId, status, attachments }) => ({ sessionId, status, attachments })),
			[{ sessionId: refs[1].sessionId, status: "open", attachments: 1 }]);
		assert.equal(a.records.slice(beforeA).filter((record) => record.type === "response" && record.command === "close_session").length, 0);
		assert.equal(b.records.slice(beforeB).filter((record) =>
			["session_closed", "session_parked", "agent_end"].includes(record.type) ||
			(record.type === "response" && record.command === "close_session")).length, 0);
		assert.deepEqual((await b.send({ type: "reclaim_session", ...refs[1] })).data,
			{ reclaimed: true, sessionId: refs[1].sessionId });
		assert.deepEqual((await b.send({ type: "list_sessions" })).data.sessions, []);

		// Parked unload through the real CLI: its reopen is its only hold, so nothing else counts as attached.
		const parkOpen = await a.send({ type: "open_session", cwd: box.cwd, retain_on_disconnect: true });
		assert.equal(parkOpen.success, true);
		const parkId = parkOpen.data.sessionId;
		const parkPath = parkOpen.data.state.sessionFile;
		const settled = a.waitFor((record) => record.type === "agent_settled" && record.sessionId === parkId, "agent_settled");
		assert.equal((await a.send({ type: "prompt", sessionId: parkId, message: "park me" })).success, true);
		await settled;
		assert.equal((await b.send({ type: "subscribe_sessions" })).success, true);
		const parked = b.waitFor((record) => record.type === "session_status" && record.sessionId === parkId &&
			record.lastChange?.cause === "park", "session parked");
		assert.deepEqual((await a.send({ type: "release_attachment", sessionId: parkId })).data, { deferred: false });
		await parked;
		const unload = await runCli(["host", "session", "unload", parkPath, "--socket", socket, "--json"], { env, cwd: box.cwd });
		writeFileSync(join(out, "cli-unload.json"), `${JSON.stringify({ code: unload.code, stdout: unload.stdout, stderr: unload.stderr }, null, 2)}\n`);
		assert.equal(unload.code, 0, unload.stdout + unload.stderr);
		const unloadPayload = JSON.parse(unload.stdout);
		assert.equal(unloadPayload.outcome, "unloaded");
		guard.assertUnchanged();
		writeFileSync(join(out, "summary.json"), `${JSON.stringify({
			pass: true, clients: 2, hosts: 1, attach: 2, release: 3, reclaim: 2,
			unrelatedSessionPreserved: true, strayCloseResponses: 0, parkedCliUnload: unloadPayload.outcome,
			cliUnloadExit: unload.code, authUnchanged: true,
		}, null, 2)}\n`);
		console.log("PASS two real CLI client processes: attach=2 release=3 reclaim=2; B remains open/attached; stray close/end=0; CLI parked unload exit=0 outcome=unloaded");
	} finally {
		for (const client of clients) await client.stop();
		host.kill("SIGTERM");
		const timer = setTimeout(() => host.kill("SIGKILL"), 10_000);
		try { await hostExit; } finally { clearTimeout(timer); }
		await model.stop();
		box.cleanup();
		rmSync(socketDir, { recursive: true, force: true });
		guard.assertUnchanged();
		writeFileSync(join(out, "transcript.jsonl"), `${transcript.map((record) => JSON.stringify(record)).join("\n")}\n`);
		writeFileSync(join(out, "host.stderr.log"), stderr);
		for (const name of ["transcript.jsonl", "host.stderr.log", "cli-unload.json", "summary.json"]) {
			try {
				const hash = createHash("sha256").update(readFileSync(join(out, name))).digest("hex");
				console.log(`${hash}  ${name}`);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
}
