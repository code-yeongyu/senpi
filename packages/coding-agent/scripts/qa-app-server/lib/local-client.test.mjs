import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { WebSocketServer } from "ws";

const qaRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const absoluteUserPath = /["'`]\/Users\/[^"'`\s]+/g;

test("real-client QA uses no absolute user dependency", async () => {
	const paths = [join(qaRoot, "real-client.mjs"), join(qaRoot, "real-client-sweep.mjs"), join(qaRoot, "lib", "local-client.mjs")];
	const offenders = [];
	for (const path of paths) {
		const source = await readFile(path, "utf8");
		for (const match of source.matchAll(absoluteUserPath)) offenders.push(`${path}: ${match[0]}`);
	}
	assert.deepEqual(offenders, []);
});

test("local read includes the persisted agent message after turn completion", async () => {
	const threadId = "thread-persisted";
	const turns = [];
	let observePersistedTurn;
	const persistedTurn = new Promise((resolve) => {
		observePersistedTurn = resolve;
	});
	const server = await protocolServer((socket, message) => {
		if (message.method === "initialize") respond(socket, message.id, {});
		if (message.method === "thread/start") respond(socket, message.id, { thread: { id: threadId } });
		if (message.method === "thread/resume") respond(socket, message.id, { thread: { id: threadId, turns } });
		if (message.method === "turn/start") {
			respond(socket, message.id, { turn: { id: "turn-persisted", status: "inProgress", items: [] } });
			const turn = {
				id: "turn-persisted",
				status: "completed",
				items: [{ type: "agentMessage", id: "agent-persisted", text: "persisted reply" }],
			};
			turns.push(turn);
			observePersistedTurn();
			socket.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn } }));
		}
		if (message.method === "thread/read") respond(socket, message.id, { thread: { id: threadId, turns: [] } });
	});
	try {
		const created = await runLocalClient(server, ["create", process.cwd()]);
		assert.equal(created.code, 0, created.stderr);
		assert.match(created.stdout, new RegExp(`Created ${threadId}`));
		const messageRun = runLocalClient(server, ["msg", threadId, "persist this"]);
		await persistedTurn;
		const messaged = await messageRun;
		assert.equal(messaged.code, 0, messaged.stderr);
		const read = await runLocalClient(server, ["read", threadId]);
		assert.equal(read.code, 0, read.stderr);
		assert.match(read.stdout, /agentMessage/);
		assert.match(read.stdout, /persisted reply/);
	} finally {
		await closeServer(server);
	}
});

test("local steer resumes the thread and sends its exact active turn id", async () => {
	const threadId = "thread-active";
	const activeTurnId = "turn-current";
	let observeSteer;
	const steerRequest = new Promise((resolve) => {
		observeSteer = resolve;
	});
	const server = await protocolServer((socket, message) => {
		if (message.method === "initialize") respond(socket, message.id, {});
		if (message.method === "thread/resume") {
			respond(socket, message.id, {
				thread: { id: threadId, turns: [{ id: activeTurnId, status: "inProgress", items: [] }] },
			});
		}
		if (message.method === "turn/steer") {
			observeSteer(message);
			respond(socket, message.id, { turnId: activeTurnId });
		}
	});
	try {
		const run = runLocalClient(server, ["steer", threadId, "redirect this turn"]);
		const request = await steerRequest;
		assert.deepEqual(request.params, {
			threadId,
			expectedTurnId: activeTurnId,
			input: [{ type: "text", text: "redirect this turn" }],
		});
		const result = await run;
		assert.equal(result.code, 0, result.stderr);
	} finally {
		await closeServer(server);
	}
});

test("local interrupt resumes the thread and sends its exact active turn id", async () => {
	const threadId = "thread-interrupt";
	const activeTurnId = "turn-authoritative";
	let observeInterrupt;
	const interruptRequest = new Promise((resolve) => {
		observeInterrupt = resolve;
	});
	const server = await protocolServer((socket, message) => {
		if (message.method === "initialize") respond(socket, message.id, {});
		if (message.method === "thread/resume") {
			respond(socket, message.id, {
				thread: {
					id: threadId,
					turns: [
						{ id: "turn-completed", status: "completed", items: [] },
						{ id: activeTurnId, status: "inProgress", items: [] },
					],
				},
			});
		}
		if (message.method === "turn/interrupt") {
			observeInterrupt(message);
			respond(socket, message.id, {});
		}
	});
	try {
		const run = runLocalClient(server, ["interrupt", threadId]);
		const request = await interruptRequest;
		assert.deepEqual(request.params, { threadId, turnId: activeTurnId });
		const result = await run;
		assert.equal(result.code, 0, result.stderr);
	} finally {
		await closeServer(server);
	}
});

test("local client initializes before executing a command", async () => {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString("utf8"));
			if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
			if (message.method === "remoteControl/status/read") {
				socket.send(JSON.stringify({ id: message.id, result: { status: "disabled" } }));
			}
		});
	});
	const address = server.address();
	assert(address && typeof address === "object");
	const child = spawn(process.execPath, [join(qaRoot, "lib", "local-client.mjs"), "status"], {
		env: { ...process.env, HOST: `ws://127.0.0.1:${address.port}`, CODEX_WS_TOKEN: "qa-token" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = [];
	const stderr = [];
	child.stdout.on("data", (chunk) => stdout.push(chunk));
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	try {
		const code = await Promise.race([
			new Promise((resolve, reject) => {
				child.once("close", resolve);
				child.once("error", reject);
			}),
			new Promise((_, reject) => setTimeout(() => reject(new Error("local client timed out")), 5000)),
		]);
		assert.equal(Buffer.concat(stderr).toString("utf8"), "");
		assert.equal(code, 0);
		assert.match(Buffer.concat(stdout).toString("utf8"), /"status": "disabled"/);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await closeServer(server);
	}
});

async function protocolServer(onMessage) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	server.on("connection", (socket) => {
		socket.on("message", (data) => onMessage(socket, JSON.parse(data.toString("utf8"))));
	});
	return server;
}

function runLocalClient(server, args) {
	const address = server.address();
	assert(address && typeof address === "object");
	const child = spawn(process.execPath, [join(qaRoot, "lib", "local-client.mjs"), ...args], {
		env: { ...process.env, HOST: `ws://127.0.0.1:${address.port}`, CODEX_WS_TOKEN: "qa-token" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = [];
	const stderr = [];
	child.stdout.on("data", (chunk) => stdout.push(chunk));
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	return Promise.race([
		new Promise((resolve, reject) => {
			child.once("close", (code) => {
				resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
			});
			child.once("error", reject);
		}),
		new Promise((_, reject) => setTimeout(() => reject(new Error("local client timed out")), 5000)),
	]).finally(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	});
}

function respond(socket, id, result) {
	socket.send(JSON.stringify({ id, result }));
}

async function closeServer(server) {
	for (const client of server.clients) client.terminate();
	await new Promise((resolve) => server.close(resolve));
}
