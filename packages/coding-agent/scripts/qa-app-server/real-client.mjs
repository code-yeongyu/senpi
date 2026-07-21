#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
	cleanupAllAndWait,
	findQaPort,
	installCleanupHooks,
	hermeticEnv,
	makeScratch,
	readGeneratedToken,
	spawnCli,
	startFakeModelServer,
	writeMockModelsJson,
} from "./lib/env.mjs";
import { fail, httpStatus, initialize, pass, WebSocketRpcClient } from "./lib/rpc.mjs";

const clientPath = "/Users/yeongyu/.agents/skills/use-codex-appserver/scripts/codex-query.ts";
const transcript = [];
const clientChildren = new Set();
const outPath = flag("--out");
let observer;
installCleanupHooks();

try {
	if (!existsSync(clientPath)) throw new Error(`missing required real client: ${clientPath}`);
	const scratch = makeScratch("app-server-real-client");
	const fake = await startFakeModelServer([
		{ text: "real-client-fast" },
		{ hold: true },
	]);
	writeMockModelsJson(scratch.agentDir, fake);
	const port = await findQaPort(18995);
	const server = spawnCli(["app-server", "--listen", `ws://127.0.0.1:${port}`], scratch);
	server.stderr.on("data", (chunk) => transcript.push(`[server stderr] ${chunk.toString("utf8").trimEnd()}`));
	await waitForFile(`${scratch.agentDir}/app-server/ws-token`, 30000);
	await waitForReadyz(port);
	const token = readGeneratedToken(scratch.agentDir);
	const clientEnv = hermeticEnv({
		...scratch.env,
		HOST: `ws://127.0.0.1:${port}`,
		CODEX_WS_TOKEN: token,
	});

	const created = await runClient(["create", scratch.cwd], clientEnv, scratch.cwd, 30000, true);
	const threadId = parseCreatedThreadId(created.stdout);
	const firstMsg = await runClient(["msg", threadId, "short prompt", "--timeout", "30"], clientEnv, scratch.cwd, 60000, true);
	if (!firstMsg.stdout.includes("real-client-fast")) {
		throw new Error("msg did not stream the agent reply text (item/agentMessage projection missing)");
	}
	const read = await runClient(["read", threadId], clientEnv, scratch.cwd, 30000, true);
	if (!read.stdout.includes("agentMessage")) {
		throw new Error("thread/read did not include a persisted agentMessage turn item");
	}
	await runClient(["threads", "10"], clientEnv, scratch.cwd, 30000, true);
	await runClient(["loaded"], clientEnv, scratch.cwd, 30000, true);

	observer = await WebSocketRpcClient.connect(port, token, transcript, "observer");
	await initialize(observer, "qa-real-client-observer");
	await observer.request("thread/resume", { threadId }, 30000);
	const observerMark = observer.mark();
	const background = spawnClient(["msg", threadId, "slow prompt", "--timeout", "60"], clientEnv, scratch.cwd);
	await observer.waitForMessageEvent(
		(message) => message.method === "turn/started" && message.params?.threadId === threadId,
		observerMark,
		30000,
	);
	transcript.push(`[observer assert] turn/started thread=${threadId} before steer/interrupt`);
	await runClient(["steer", threadId, "please stop after this"], clientEnv, scratch.cwd, 30000, true);
	const interruptMark = observer.mark();
	await runClient(["interrupt", threadId], clientEnv, scratch.cwd, 30000, true);
	const interrupted = await observer.waitForMessageEvent(
		(message) => message.method === "turn/completed" && message.params?.threadId === threadId,
		interruptMark,
		30000,
	);
	if (interrupted.params?.turn?.status !== "interrupted") {
		throw new Error(`interrupt terminal status was ${interrupted.params?.turn?.status ?? "missing"}`);
	}
	fake.releaseHolds();
	const backgroundResult = await waitChild(background, 70000);
	transcript.push(`[client bg exit] ${backgroundResult.code}`);
	const finalRead = await runClient(["read", threadId, "--full"], clientEnv, scratch.cwd, 30000, true);
	if (!finalRead.stdout.includes("status:interrupted")) {
		throw new Error("final read did not show interrupted turn");
	}

	await fake.stop();
	pass(transcript, "real-client");
} catch (error) {
	fail(transcript, "real-client", error);
	process.exitCode = 1;
} finally {
	observer?.close();
	for (const child of clientChildren) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await cleanupAllAndWait();
	if (outPath) writeFileSync(outPath, `${transcript.join("\n")}\n`);
	if (transcript.length > 0) process.stdout.write(`${transcript.join("\n")}\n`);
	process.exit(process.exitCode ?? 0);
}

function runClient(args, env, cwd, timeoutMs, assertZero) {
	return waitChild(spawnClient(args, env, cwd), timeoutMs).then((result) => {
		if (assertZero && result.code !== 0) {
			throw new Error(`codex-query ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
		}
		return result;
	});
}

function spawnClient(args, env, cwd) {
	transcript.push(`[client >>] ${args.join(" ")}`);
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
			rejectWait(error);
		});
	});
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
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if ((await httpStatus(port, "/readyz").catch(() => 0)) === 200) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Timed out waiting for /readyz");
}

function parseCreatedThreadId(stdout) {
	const match = stdout.match(/Created (\S+)/);
	if (!match) throw new Error(`could not parse created thread id from ${stdout}`);
	return match[1];
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}
