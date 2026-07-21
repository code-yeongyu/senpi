#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import {
	cleanupAllAndWait,
	findQaPort,
	hermeticEnv,
	installCleanupHooks,
	makeScratch,
	readGeneratedToken,
	spawnCli,
	startFakeModelServer,
	writeMockModelsJson,
} from "./lib/env.mjs";
import { fail, httpStatus, initialize, pass, WebSocketRpcClient } from "./lib/rpc.mjs";

const clientPath = "/Users/yeongyu/.agents/skills/use-codex-appserver/scripts/codex-query.ts";
const outApiMethods = Object.freeze([
	"config/value/write",
	"plugin/list",
	"fs/readFile",
	"fs/readDirectory",
	"command/exec",
]);
const transcript = [];
const clientChildren = new Set();
const outcomes = [];
const outPath = flag("--out");
const baselineRed = process.argv.includes("--expect-baseline-red");
let fake;
let observer;
let proxy;
installCleanupHooks();

try {
	if (!existsSync(clientPath)) throw new Error(`missing required real client: ${clientPath}`);
	const setup = await bootSweepDaemon();
	if (baselineRed) {
		await runBaselineRed(setup);
	} else {
		await runSweep(setup);
		pass(transcript, "real-client-sweep");
	}
} catch (error) {
	fail(transcript, "real-client-sweep", error);
	process.exitCode = 1;
} finally {
	observer?.close();
	for (const child of clientChildren) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await proxy?.stop();
	await fake?.stop();
	await cleanupAllAndWait();
	if (outPath) writeFileSync(outPath, `${transcript.join("\n")}\n`);
	if (transcript.length > 0) process.stdout.write(`${transcript.join("\n")}\n`);
	process.exit(process.exitCode ?? 0);
}

async function bootSweepDaemon() {
	const scratch = makeScratch("app-server-real-client-sweep");
	const home = join(scratch.dir, "home");
	mkdirSync(home, { recursive: true });
	scratch.env.HOME = home;
	delete scratch.env.CODEX_HOME;
	delete scratch.env.CODEX_WS_TOKEN;
	delete scratch.env.HOST;
	writeFileSync(join(scratch.agentDir, "settings.json"), JSON.stringify({ permissionPreset: "ask" }, null, 2));
	fake = await startFakeModelServer([
		{ toolCalls: [{ name: "bash", args: { command: "echo sweep-accept" } }] },
		{ text: "sweep accept completed" },
		{ toolCalls: [{ name: "bash", args: { command: "printf sweep-decline" } }] },
		{ text: "sweep decline completed" },
		{ hold: true },
	]);
	writeMockModelsJson(scratch.agentDir, fake);
	const daemonPort = await findQaPort();
	const server = spawnCli(["app-server", "--listen", `ws://127.0.0.1:${daemonPort}`], scratch);
	server.stderr.on("data", (chunk) => transcript.push(`[server stderr] ${chunk.toString("utf8").trimEnd()}`));
	await waitForFile(join(scratch.agentDir, "app-server", "ws-token"), 30000);
	await waitForReadyz(daemonPort);
	const token = readGeneratedToken(scratch.agentDir);
	const proxyPort = await findQaPort();
	proxy = await startRecordingProxy(daemonPort, proxyPort);
	const clientEnv = hermeticEnv({
		...scratch.env,
		HOST: `ws://127.0.0.1:${proxyPort}`,
		CODEX_WS_TOKEN: token,
	});
	assertSafeClientEnv(clientEnv);
	transcript.push(`SWEEP_DAEMON_PORT=${daemonPort} SWEEP_CLIENT_PORT=${proxyPort} TOKEN=generated`);
	return { scratch, daemonPort, token, clientEnv };
}

async function runSweep({ scratch, daemonPort, token, clientEnv }) {
	const helpConnections = proxy.connectionCount;
	await runClientCommand("help", ["help"], clientEnv, scratch.cwd, 0);
	if (proxy.connectionCount !== helpConnections) {
		throw new Error("help opened a websocket connection");
	}
	transcript.push("HELP_CONNECTIONS=0");

	await runClientCommand("status", ["status"], clientEnv, scratch.cwd, 0, (result) => {
		if (!result.stdout.includes('"status": "disabled"')) {
			throw new Error(`status did not render disabled state: ${result.stdout}`);
		}
	});

	const clientsMark = proxy.traffic.length;
	await runClientCommand("clients", ["clients"], clientEnv, scratch.cwd, 1, (result) => {
		if (!result.stderr.includes("remote control is not active (status: disabled)")) {
			throw new Error(`clients did not emit disabled diagnostic: ${result.stderr}`);
		}
	});
	assertClientsTraffic(proxy.traffic.slice(clientsMark));

	const fullCreate = await runClientCommand("create", ["create", scratch.cwd], clientEnv, scratch.cwd, 0);
	const fullThreadId = parseCreatedThreadId(fullCreate.stdout);
	const safeCreate = await runClientCommand("create-safe", ["create", scratch.cwd, "--safe"], clientEnv, scratch.cwd, 0);
	parseCreatedThreadId(safeCreate.stdout);
	observer = await WebSocketRpcClient.connect(daemonPort, token, [], "observer");
	await initialize(observer, "qa-real-client-sweep-observer");
	const approvalThread = await observer.request("thread/start", {
		cwd: scratch.cwd,
		model: "mock/mock-model",
		modelProvider: "mock",
		approvalPolicy: "on-request",
	});
	const threadId = approvalThread?.thread?.id;
	if (typeof threadId !== "string" || threadId.length === 0) {
		throw new Error(`approval fixture thread/start did not return a thread id: ${JSON.stringify(approvalThread)}`);
	}

	await runClientCommand("threads", ["threads", "10"], clientEnv, scratch.cwd, 0);
	await runClientCommand("active", ["active"], clientEnv, scratch.cwd, 0);
	await runClientCommand("loaded", ["loaded"], clientEnv, scratch.cwd, 0);
	await runClientCommand("rename", ["rename", fullThreadId, "sweep archived thread"], clientEnv, scratch.cwd, 0);
	await runClientCommand("archive", ["archive", fullThreadId], clientEnv, scratch.cwd, 0);

	const accept = await runClientCommand(
		"msg-accept",
		["msg", threadId, "accept this scripted command", "--timeout", "30"],
		clientEnv,
		scratch.cwd,
		0,
	);
	if (!accept.stdout.includes("finished: completed")) {
		throw new Error(`accept message did not complete: ${accept.stdout}`);
	}
	assertDecision("msg-accept", "acceptForSession");

	await runClientCommand("search", ["search", "sweep", "--limit", "10"], clientEnv, scratch.cwd, 0);
	await runClientCommand("read", ["read", threadId, "--full"], clientEnv, scratch.cwd, 0);
	await runClientCommand("answer", ["answer", threadId], clientEnv, scratch.cwd, 0);

	const decline = await runClientCommand(
		"msg-decline",
		["msg", threadId, "decline this scripted command", "--decline", "--timeout", "30"],
		clientEnv,
		scratch.cwd,
		0,
	);
	if (!decline.stdout.includes("finished: completed")) {
		throw new Error(`decline message did not reach completed terminal state: ${decline.stdout}`);
	}
	assertDecision("msg-decline", "decline");
	if (fake.requests.length < 4) {
		throw new Error(`scripted approval fixture did not complete both model continuations: ${fake.requests.length}`);
	}
	transcript.push("DECLINE_FIXTURE=tool-call DECISION=decline TERMINAL=completed");

	await observer.request("thread/resume", { threadId }, 30000);
	const turnStartedMark = observer.mark();
	const background = spawnClient("msg-interrupted", ["msg", threadId, "hold until interrupted", "--timeout", "60"], clientEnv, scratch.cwd);
	await observer.waitForMessageEvent(
		(message) => message.method === "turn/started" && message.params?.threadId === threadId,
		turnStartedMark,
		30000,
	);
	transcript.push(`[observer assert] turn/started thread=${threadId} before steer/interrupt`);

	await runClientCommand("steer", ["steer", threadId, "please stop after this"], clientEnv, scratch.cwd, 0);
	const interruptMark = observer.mark();
	await runClientCommand("interrupt", ["interrupt", threadId], clientEnv, scratch.cwd, 0);
	const interrupted = await observer.waitForMessageEvent(
		(message) => message.method === "turn/completed" && message.params?.threadId === threadId,
		interruptMark,
		30000,
	);
	if (interrupted.params?.turn?.status !== "interrupted") {
		throw new Error(`interrupt terminal status was ${interrupted.params?.turn?.status ?? "missing"}`);
	}
	fake.releaseHolds();
	const backgroundResult = await waitChild(background, 30000);
	recordOutcome("msg-interrupted", 1, backgroundResult.code);
	if (backgroundResult.code !== 1 || !backgroundResult.stdout.includes("finished: interrupted")) {
		throw new Error(`interrupted background msg result was ${JSON.stringify(backgroundResult)}`);
	}
	transcript.push("BACKGROUND_MSG_EXIT=1 INTERRUPT_EXIT=0 STEER_EXIT=0 TERMINAL=interrupted");

	for (const method of outApiMethods) await assertOutApiMissing(observer, method);
	const cliM32601Count = proxy.traffic.filter((entry) => entry.message?.error?.code === -32601).length;
	transcript.push(`CLI_M32601_COUNT=${cliM32601Count}`);
	if (cliM32601Count !== 0) throw new Error(`CLI-command traffic contained ${cliM32601Count} -32601 response(s)`);
	transcript.push(`OUT_API_M32601=${outApiMethods.length}`);
	transcript.push(`MODEL_REQUESTS=${fake.requests.length} MODEL_PROVIDER=fake`);
	printOutcomes();
}

async function runBaselineRed({ scratch, clientEnv }) {
	const failures = [];
	const status = await runClientCommand("red-status", ["status"], clientEnv, scratch.cwd);
	if (status.code === 0 && !status.stdout.includes('"status": "disabled"')) {
		failures.push("status rendered a non-disabled remote-control state");
		transcript.push("RED_STATUS=failed non-disabled-state");
	} else {
		failures.push(`status exit=${status.code}`);
		transcript.push(`RED_STATUS=failed exit=${status.code}`);
	}
	const search = await runClientCommand("red-search", ["search", "sweep"], clientEnv, scratch.cwd);
	const searchM32601 = proxy.traffic.some(
		(entry) => entry.label === "red-search" && entry.direction === "S->C" && entry.message?.error?.code === -32601,
	);
	if (search.code !== 0 && searchM32601) {
		failures.push("search returned -32601");
		transcript.push("RED_SEARCH=failed code=-32601");
	} else {
		failures.push(`search exit=${search.code} m32601=${searchM32601}`);
		transcript.push(`RED_SEARCH=failed exit=${search.code} m32601=${searchM32601}`);
	}
	transcript.push(`BASELINE_RED_FAILURES=${failures.length}`);
	throw new Error(`baseline RED proof observed: ${failures.join("; ")}`);
}

function runClientCommand(label, args, env, cwd, expectedCode, assertResult) {
	return waitChild(spawnClient(label, args, env, cwd), 60000).then((result) => {
		if (expectedCode !== undefined) {
			recordOutcome(label, expectedCode, result.code);
			if (result.code !== expectedCode) {
				throw new Error(`codex-query ${args.join(" ")} exited ${result.code}, expected ${expectedCode}\n${result.stderr}`);
			}
		}
		assertResult?.(result);
		return result;
	});
}

function spawnClient(label, args, env, cwd) {
	assertSafeClientEnv(env);
	proxy.setNextClientLabel(label);
	transcript.push(`[client ${label} >>] ${args.join(" ")}`);
	const child = spawn(process.execPath, [clientPath, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	clientChildren.add(child);
	child.stdoutText = "";
	child.stderrText = "";
	child.stdout.on("data", (chunk) => {
		child.stdoutText += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		child.stderrText += chunk.toString("utf8");
	});
	return child;
}

function waitChild(child, timeoutMs) {
	return new Promise((resolveWait, rejectWait) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectWait(new Error(`codex-query timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("close", (code) => {
			clearTimeout(timeout);
			clientChildren.delete(child);
			const result = { code, stdout: child.stdoutText, stderr: child.stderrText };
			transcript.push(`[client << exit=${code}] stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`);
			resolveWait(result);
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			clientChildren.delete(child);
			rejectWait(error);
		});
	});
}

function assertSafeClientEnv(env) {
	if (typeof env.HOST !== "string" || env.HOST.length === 0) {
		throw new Error("refusing to spawn codex-query without HOST");
	}
	const host = new URL(env.HOST);
	const port = Number(host.port);
	if (host.protocol !== "ws:" || host.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 18990 || port > 18999) {
		throw new Error(`refusing to spawn codex-query outside QA port range: ${env.HOST}`);
	}
	if (typeof env.CODEX_WS_TOKEN !== "string" || env.CODEX_WS_TOKEN.length === 0) {
		throw new Error("refusing to spawn codex-query without CODEX_WS_TOKEN");
	}
}

function assertClientsTraffic(traffic) {
	const methods = traffic
		.filter((entry) => entry.direction === "C->S" && typeof entry.message?.method === "string")
		.map((entry) => entry.message.method)
		.filter((method) => method !== "initialize" && method !== "initialized");
	if (methods.length !== 1 || methods[0] !== "remoteControl/status/read") {
		throw new Error(`clients traffic was ${methods.join(", ") || "empty"}, expected only remoteControl/status/read`);
	}
	transcript.push(`CLIENTS_APP_METHODS=${methods.join(",")}`);
}

function assertDecision(label, decision) {
	const found = proxy.traffic.some(
		(entry) => entry.label === label && entry.direction === "C->S" && entry.message?.result?.decision === decision,
	);
	if (!found) throw new Error(`${label} did not send ${decision} approval decision`);
}

async function assertOutApiMissing(client, method) {
	const id = `out-${method}`;
	const mark = client.mark();
	client.write({ id, method, params: {} });
	const response = await client.waitForMessageEvent((message) => message.id === id && !("method" in message), mark, 30000);
	if (response.error?.code !== -32601) {
		throw new Error(`${method} returned ${JSON.stringify(response)}, expected clean -32601`);
	}
	transcript.push(`OUT_API ${method} CODE=-32601`);
}

function recordOutcome(label, expected, actual) {
	outcomes.push({ label, expected, actual });
}

function printOutcomes() {
	transcript.push("SWEEP_OUTCOMES=expected");
	for (const outcome of outcomes) {
		transcript.push(`OUTCOME ${outcome.label} expected=${outcome.expected} actual=${outcome.actual}`);
	}
}

function parseCreatedThreadId(stdout) {
	const match = stdout.match(/Created (\S+)/);
	if (!match) throw new Error(`could not parse created thread id from ${stdout}`);
	return match[1];
}

async function waitForFile(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForReadyz(port) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if ((await httpStatus(port, "/readyz").catch(() => 0)) === 200) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Timed out waiting for /readyz");
}

async function startRecordingProxy(targetPort, proxyPort) {
	const traffic = [];
	const upstreams = new Set();
	let connectionCount = 0;
	let nextClientLabel = "unlabeled";
	const server = new WebSocketServer({ host: "127.0.0.1", port: proxyPort });
	await new Promise((resolveOpen, rejectOpen) => {
		server.once("listening", resolveOpen);
		server.once("error", rejectOpen);
	});
	server.on("connection", (client, request) => {
		connectionCount += 1;
		const connectionId = connectionCount;
		const label = nextClientLabel;
		const authorization = request.headers.authorization;
		const upstream = new WebSocket(`ws://127.0.0.1:${targetPort}/`, {
			headers: authorization === undefined ? {} : { Authorization: authorization },
		});
		upstreams.add(upstream);
		const queued = [];
		let upstreamOpen = false;
		const forwardUpstream = (data, isBinary) => {
			if (upstreamOpen) upstream.send(data, { binary: isBinary });
			else queued.push({ data, isBinary });
		};
		client.on("message", (data, isBinary) => {
			recordWire(traffic, label, connectionId, "C->S", data, transcript);
			forwardUpstream(data, isBinary);
		});
		upstream.on("open", () => {
			upstreamOpen = true;
			for (const frame of queued) upstream.send(frame.data, { binary: frame.isBinary });
			queued.length = 0;
		});
		upstream.on("message", (data, isBinary) => {
			recordWire(traffic, label, connectionId, "S->C", data, transcript);
			if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
		});
		client.once("close", () => {
			if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
		});
		upstream.once("close", () => {
			upstreams.delete(upstream);
			if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.terminate();
		});
		upstream.once("error", (error) => transcript.push(`[proxy ${label} upstream error] ${error.message}`));
	});
	return {
		traffic,
		setNextClientLabel(label) {
			nextClientLabel = label;
		},
		get connectionCount() {
			return connectionCount;
		},
		stop: () =>
			new Promise((resolveStop) => {
				for (const client of server.clients) client.terminate();
				for (const upstream of upstreams) upstream.terminate();
				server.close(() => resolveStop());
			}),
	};
}

function recordWire(traffic, label, connectionId, direction, data, transcript) {
	const raw = data.toString("utf8");
	let message;
	try {
		message = JSON.parse(raw);
	} catch {
		message = { raw };
	}
	traffic.push({ label, connectionId, direction, message });
	if (direction === "C->S" || message.error !== undefined || (typeof message.method === "string" && "id" in message)) {
		transcript.push(`[wire ${label} ${direction}] ${raw}`);
	}
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}
