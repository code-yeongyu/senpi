#!/usr/bin/env node
import process from "node:process";
import WebSocket from "ws";

const [command = "help", ...args] = process.argv.slice(2);

if (command === "help") {
	process.stdout.write("Commands: help status clients create threads active loaded rename archive msg search read answer steer interrupt\n");
	process.exit(0);
}

async function run(name, argv, rpc) {
	switch (name) {
		case "status": {
			print(await rpc.request("remoteControl/status/read", {}));
			return;
		}
		case "clients": {
			const result = await rpc.request("remoteControl/status/read", {});
			if (result?.status === "disabled") fail("remote control is not active (status: disabled)");
			print(result);
			return;
		}
		case "create": {
			const cwd = argv[0] ?? process.cwd();
			const safe = argv.includes("--safe");
			const result = await rpc.request("thread/start", {
				cwd,
				model: "mock/mock-model",
				modelProvider: "mock",
				approvalPolicy: safe ? "never" : "on-request",
			});
			process.stdout.write(`Created ${threadId(result)}\n`);
			return;
		}
		case "threads":
		case "active":
		case "loaded": {
			print(await rpc.request("thread/list", { limit: numberArg(argv[0], 20) }));
			return;
		}
		case "search": {
			print(await rpc.request("thread/list", { searchTerm: argv[0] ?? "", limit: optionNumber(argv, "--limit", 20) }));
			return;
		}
		case "rename": {
			await rpc.request("thread/name/set", { threadId: required(argv[0], "thread id"), name: argv.slice(1).join(" ") });
			return;
		}
		case "archive": {
			await rpc.request("thread/archive", { threadId: required(argv[0], "thread id") });
			return;
		}
		case "read": {
			const result = await rpc.request("thread/resume", { threadId: required(argv[0], "thread id") });
			print(result);
			printProjection(result);
			return;
		}
		case "msg": {
			const id = required(argv[0], "thread id");
			const text = required(argv[1], "message");
			await rpc.request("thread/resume", { threadId: id });
			const completion = rpc.waitFor((message) => message.method === "turn/completed" && message.params?.threadId === id);
			const removeApproval = rpc.onRequest("item/commandExecution/requestApproval", (message) => {
				rpc.respond(message.id, { decision: argv.includes("--decline") ? "decline" : "acceptForSession" });
			});
			const removeDelta = rpc.onNotification("item/agentMessage/delta", (message) => {
				if (message.params?.threadId === id) process.stdout.write(message.params?.delta ?? "");
			});
			try {
				await rpc.request("turn/start", { threadId: id, input: [{ type: "text", text }] });
				const terminal = await completion;
				const status = terminal.params?.turn?.status ?? "unknown";
				process.stdout.write(`\nfinished: ${status}\n`);
				if (status !== "completed") process.exitCode = 1;
			} finally {
				removeApproval();
				removeDelta();
			}
			return;
		}
		case "steer": {
			const id = required(argv[0], "thread id");
			await rpc.request("turn/steer", {
				threadId: id,
				expectedTurnId: await currentTurnId(rpc, id),
				input: [{ type: "text", text: required(argv[1], "message") }],
			});
			return;
		}
		case "interrupt": {
			const id = required(argv[0], "thread id");
			await rpc.request("turn/interrupt", { threadId: id, turnId: await currentTurnId(rpc, id) });
			return;
		}
		case "answer":
			return;
		default:
			fail(`unknown command: ${name}`);
	}
}

class RpcClient {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.waiters = new Set();
		this.requestHandlers = new Map();
		this.notificationHandlers = new Map();
		socket.on("message", (data) => this.receive(data));
	}

	static connect(host, token) {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(host, { headers: { Authorization: `Bearer ${token}` } });
			socket.once("open", () => resolve(new RpcClient(socket)));
			socket.once("error", reject);
		});
	}

	request(method, params) {
		const id = this.nextId++;
		this.socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	notify(method, params) {
		this.socket.send(JSON.stringify({ method, params }));
	}

	respond(id, result) {
		this.socket.send(JSON.stringify({ id, result }));
	}

	waitFor(predicate, timeoutMs = 60000) {
		return new Promise((resolve, reject) => {
			const waiter = { predicate, resolve, reject };
			this.waiters.add(waiter);
			waiter.timeout = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error("timed out waiting for app-server notification"));
			}, timeoutMs);
		});
	}

	onRequest(method, handler) {
		return this.addHandler(this.requestHandlers, method, handler);
	}

	onNotification(method, handler) {
		return this.addHandler(this.notificationHandlers, method, handler);
	}

	addHandler(collection, method, handler) {
		const handlers = collection.get(method) ?? new Set();
		handlers.add(handler);
		collection.set(method, handlers);
		return () => handlers.delete(handler);
	}

	receive(data) {
		const message = JSON.parse(data.toString("utf8"));
		if (!("method" in message)) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
			else pending.resolve(message.result);
			return;
		}
		const collection = "id" in message ? this.requestHandlers : this.notificationHandlers;
		for (const handler of collection.get(message.method) ?? []) handler(message);
		for (const waiter of this.waiters) {
			if (!waiter.predicate(message)) continue;
			clearTimeout(waiter.timeout);
			this.waiters.delete(waiter);
			waiter.resolve(message);
		}
	}

	close() {
		this.socket.close();
	}
}

const host = process.env.HOST;
const token = process.env.CODEX_WS_TOKEN;
if (!host || !token) throw new Error("HOST and CODEX_WS_TOKEN are required");

const client = await RpcClient.connect(host, token);
try {
	await client.request("initialize", {
		clientInfo: { name: "senpi-qa-local-client", title: "senpi-qa-local-client", version: "0.0.0" },
		capabilities: { experimentalApi: true },
	});
	client.notify("initialized", {});
	await run(command, args, client);
} finally {
	client.close();
}

function print(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printProjection(result) {
	for (const turn of result?.thread?.turns ?? []) {
		process.stdout.write(`status:${turn.status}\n`);
		for (const item of turn.items ?? []) process.stdout.write(`${item.type}\n`);
	}
}

function threadId(result) {
	return required(result?.thread?.id, "thread/start result thread id");
}

async function currentTurnId(rpc, threadId) {
	const resumed = await rpc.request("thread/resume", { threadId });
	const activeTurn = resumed?.thread?.turns?.findLast((turn) => turn.status === "inProgress");
	return required(activeTurn?.id, "active turn id");
}

function required(value, label) {
	if (typeof value !== "string" || value.length === 0) fail(`missing ${label}`);
	return value;
}

function numberArg(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function optionNumber(argv, option, fallback) {
	const index = argv.indexOf(option);
	return index === -1 ? fallback : numberArg(argv[index + 1], fallback);
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
