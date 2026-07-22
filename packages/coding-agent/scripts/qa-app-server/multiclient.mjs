#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import {
	cleanupAllAndWait,
	findQaPort,
	installCleanupHooks,
	makeScratch,
	makeTextInput,
	makeThreadStartParams,
	readGeneratedToken,
	spawnCli,
	startFakeModelServer,
	writeMockModelsJson,
} from "./lib/env.mjs";
import {
	assertTurnStream,
	fail,
	httpStatus,
	initialize,
	pass,
	requiredThreadId,
	upgradeStatus,
	waitFor,
	WebSocketRpcClient,
} from "./lib/rpc.mjs";

const transcript = [];
const outPath = flag("--out");
const negative = process.argv.includes("--self-test-negative");
installCleanupHooks();

try {
	const scratch = makeScratch("app-server-multiclient");
	const fake = await startFakeModelServer([{ text: "multi-one" }, { text: "multi-two" }]);
	writeMockModelsJson(scratch.agentDir, fake);
	const port = await findQaPort();
	const child = spawnCli(["app-server", "--listen", `ws://127.0.0.1:${port}`], scratch);
	child.stderr.on("data", (chunk) => transcript.push(`[server stderr] ${chunk.toString("utf8").trimEnd()}`));
	await waitFor(() => (existsSync(`${scratch.agentDir}/app-server/ws-token`) ? true : undefined), 30000, "ws token");
	await waitForReadyz(port);
	const token = readGeneratedToken(scratch.agentDir);
	if ((await httpStatus(port, "/readyz")) !== 200) throw new Error("/readyz did not return 200");
	if ((await httpStatus(port, "/readyz", { Origin: "https://example.test" })) !== 403) {
		throw new Error("Origin request did not return 403");
	}
	const authRejectStatus = await upgradeStatus(port);
	transcript.push(`authRejectStatus=${authRejectStatus}`);
	if (![401, 403].includes(authRejectStatus)) {
		throw new Error(`unauthenticated websocket upgrade returned ${authRejectStatus}, expected 401 or 403`);
	}
	const badTokenRejectStatus = await upgradeStatus(port, { Authorization: "Bearer bad-token" });
	transcript.push(`badTokenRejectStatus=${badTokenRejectStatus}`);
	if (![401, 403].includes(badTokenRejectStatus)) {
		throw new Error(`bad-token websocket upgrade returned ${badTokenRejectStatus}, expected 401 or 403`);
	}

	const clientA = await WebSocketRpcClient.connect(port, token, transcript, "A");
	const clientB = await WebSocketRpcClient.connect(port, token, transcript, "B");
	await initialize(clientA, "qa-multiclient-a");
	await initialize(clientB, "qa-multiclient-b");
	const started = await clientA.request("thread/start", makeThreadStartParams(scratch.cwd));
	const threadId = requiredThreadId(started);
	const firstMark = clientA.mark();
	await clientA.request("turn/start", { threadId, input: makeTextInput("first turn") }, 30000);
	await assertTurnStream(clientA, threadId, firstMark);

	await clientB.request("thread/resume", { threadId }, 30000);
	const secondMarkA = clientA.mark();
	const secondMarkB = clientB.mark();
	await clientA.request("turn/start", { threadId, input: makeTextInput("second turn") }, 30000);
	await assertTurnStream(clientA, threadId, secondMarkA);
	const terminalForB = await assertTurnStream(clientB, threadId, secondMarkB);
	if (negative) {
		throw new Error(`negative self-test expected terminal event to be withheld, got ${terminalForB.method}`);
	}
	clientA.assertServerEnvelopes();
	clientB.assertServerEnvelopes();

	clientA.close();
	clientB.close();
	await fake.stop();
	pass(transcript, "multiclient");
} catch (error) {
	fail(transcript, "multiclient", error);
	process.exitCode = 1;
} finally {
	await cleanupAllAndWait();
	if (outPath) writeFileSync(outPath, `${transcript.join("\n")}\n`);
	if (transcript.length > 0) process.stdout.write(`${transcript.join("\n")}\n`);
	process.exit(process.exitCode ?? 0);
}

async function waitForReadyz(port) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if ((await httpStatus(port, "/readyz").catch(() => 0)) === 200) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Timed out waiting for /readyz");
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}
