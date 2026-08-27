#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
	cleanupAllAndWait,
	installCleanupHooks,
	makeScratch,
	spawnCli,
	startFakeModelServer,
	writeMockModelsJson,
} from "../qa-app-server/lib/env.mjs";
import { trackCloser, untrackCloser } from "../qa-app-server/lib/cleanup.mjs";
import { fail, pass } from "../qa-app-server/lib/rpc.mjs";

const transcript = [];
const outPath = flag("--out");
installCleanupHooks();
transcript.push("cleanup-hooks=installed");

async function main() {
try {
	const scratch = makeScratch("rpc-socket");
	const socketPath = join(scratch.dir, "rpc.sock");
	const fake = await startFakeModelServer([{ hold: true }]);
	writeMockModelsJson(scratch.agentDir, fake);
	const child = spawnCli(
		[
			"--mode",
			"rpc",
			"--listen",
			`unix://${socketPath}`,
			"--provider",
			"mock",
			"--model",
			"mock-model",
		],
		scratch,
	);
	await waitForStderr(child, `senpi rpc listening on unix://${socketPath}`);
	const a = await SocketRpcClient.connect(socketPath, transcript, "A");
	const b = await SocketRpcClient.connect(socketPath, transcript, "B");

	const malformedMark = a.mark();
	a.writeRaw("{bad first frame\n");
	await a.waitFor(
		(message) => message.type === "response" && message.command === "parse" && message.success === false,
		malformedMark,
	);
	await b.request({ type: "get_protocol_info" });
	transcript.push("assert malformed-first-frame=typed-error host-survived=true");

	const opened = await a.request({ type: "open_session", cwd: scratch.cwd });
	const sessionId = opened.data?.sessionId;
	if (typeof sessionId !== "string") throw new Error(`open_session missing routing id: ${JSON.stringify(opened)}`);
	const eventMarkA = a.mark();
	const eventMarkB = b.mark();
	await b.request({ type: "prompt", sessionId, message: "qa-cross-connection-unique" });
	await Promise.all([
		a.waitFor((message) => message.type === "agent_start" && message.sessionId === sessionId, eventMarkA),
		b.waitFor((message) => message.type === "agent_start" && message.sessionId === sessionId, eventMarkB),
	]);
	await a.waitFor(
		(message) => message.type === "message_start" && message.sessionId === sessionId && message.message?.role === "assistant",
		eventMarkA,
	);
	b.close();
	const reconnect = await SocketRpcClient.connect(socketPath, transcript, "B2");
	const settledA = a.waitFor((message) => message.type === "agent_settled" && message.sessionId === sessionId, eventMarkA);
	const settledReconnect = reconnect.waitFor(
		(message) => message.type === "agent_settled" && message.sessionId === sessionId,
		reconnect.mark(),
	);
	fake.releaseHolds();
	await Promise.all([settledA, settledReconnect]);
	const messages = await reconnect.request({ type: "get_messages", sessionId });
	const transcriptText = (messages.data?.messages ?? []).map(messageText).join("\n");
	if (!transcriptText.includes("qa-cross-connection-unique")) {
		throw new Error(`target transcript did not contain foreign prompt: ${transcriptText}`);
	}
	transcript.push(`assert cross-connection-delivery=target-transcript sessionId=${sessionId}`);
	transcript.push(`assert non-owner-event-receipt=A+B agent_start sessionId=${sessionId}`);
	transcript.push("assert connection-drop=mid-command reconnect-received-settlement=true");

	const midMark = a.mark();
	a.writeRaw("not-json-mid-stream\n");
	await a.waitFor(
		(message) => message.type === "response" && message.command === "parse" && message.success === false,
		midMark,
	);
	await reconnect.request({ type: "get_state", sessionId });
	transcript.push("assert malformed-mid-stream=typed-error reconnect-live-session=true");

	a.close();
	reconnect.close();
	await fake.stop();
	pass(transcript, "rpc-socket");
} catch (error) {
	fail(transcript, "rpc-socket", error);
	process.exitCode = 1;
} finally {
	await cleanupAllAndWait();
	transcript.push("cleanup=children,sockets,scratch-closed");
	if (outPath) writeFileSync(outPath, `${transcript.join("\n")}\n`);
	if (transcript.length > 0) process.stdout.write(`${transcript.join("\n")}\n`);
	process.exit(process.exitCode ?? 0);
}
}

class SocketRpcClient {
	constructor(socket, transcript, label) {
		this.socket = socket;
		this.cleanupSocket = () => socket.destroy();
		trackCloser(this.cleanupSocket);
		this.transcript = transcript;
		this.label = label;
		this.messages = [];
		this.waiters = new Set();
		this.buffer = "";
		socket.on("data", (chunk) => this.read(chunk.toString("utf8")));
	}

	static async connect(socketPath, transcript, label) {
		const socket = createConnection(socketPath);
		await withTimeout(
			new Promise((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			}),
			10_000,
			`${label} connect`,
		);
		return new SocketRpcClient(socket, transcript, label);
	}

	mark() {
		return this.messages.length;
	}

	async request(command, timeoutMs = 20_000) {
		const id = `${this.label}-${this.messages.length + 1}`;
		const mark = this.mark();
		this.write({ id, ...command });
		const response = await this.waitFor(
			(message) => message.type === "response" && message.id === id,
			mark,
			timeoutMs,
		);
		if (!response.success) throw new Error(`${command.type} failed: ${response.error}`);
		return response;
	}

	write(value) {
		this.writeRaw(`${JSON.stringify(value)}\n`);
	}

	writeRaw(line) {
		this.transcript.push(`[${this.label} >>] ${line.trimEnd()}`);
		this.socket.write(line);
	}

	waitFor(predicate, fromIndex = 0, timeoutMs = 20_000) {
		const existing = this.messages.slice(fromIndex).find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = { predicate, fromIndex, resolve, reject, timer: undefined };
			waiter.timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`Timed out waiting for ${this.label} RPC record`));
			}, timeoutMs);
			this.waiters.add(waiter);
		});
	}

	close() {
		untrackCloser(this.cleanupSocket);
		this.cleanupSocket();
	}

	read(text) {
		this.buffer += text;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const index = this.messages.length;
			this.messages.push(message);
			this.transcript.push(`[${this.label} <<] ${line}`);
			for (const waiter of [...this.waiters]) {
				if (index < waiter.fromIndex || !waiter.predicate(message)) continue;
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
	}
}

function messageText(message) {
	if (!message || typeof message !== "object") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function waitForStderr(child, expected, timeoutMs = 20_000) {
	let stderr = "";
	return withTimeout(
		new Promise((resolve, reject) => {
			const onData = (chunk) => {
				stderr += chunk.toString("utf8");
				transcript.push(`[host stderr] ${chunk.toString("utf8").trimEnd()}`);
				if (stderr.includes(expected)) {
					child.stderr.off("data", onData);
					resolve();
				}
			};
			child.stderr.on("data", onData);
			child.once("exit", (code, signal) => reject(new Error(`host exited ${code ?? signal}: ${stderr}`)));
		}),
		timeoutMs,
		"host readiness",
	);
}

function withTimeout(promise, timeoutMs, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

main();

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}
