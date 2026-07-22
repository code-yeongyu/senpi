#!/usr/bin/env node
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
	cleanupAllAndWait,
	installCleanupHooks,
	makeScratch,
	makeTextInput,
	makeThreadStartParams,
	spawnCli,
	startFakeModelServer,
	writeMockModelsJson,
} from "./lib/env.mjs";
import { fail, initialize, pass, requiredThreadId, StdioRpcClient } from "./lib/rpc.mjs";

const transcript = [];
const outPath = flag("--out");
installCleanupHooks();

try {
	const scratch = makeScratch("app-server-approval");
	const fake = await startFakeModelServer([
		{ toolCalls: [{ name: "bash", args: { command: "echo hi" } }] },
		{ text: "approval complete" },
	]);
	writeMockModelsJson(scratch.agentDir, fake);
	writeFileSync(join(scratch.agentDir, "settings.json"), JSON.stringify({ permissionPreset: "ask" }, null, 2));
	const child = spawnCli(["app-server"], scratch);
	const client = new StdioRpcClient(child, transcript, "stdio");
	await initialize(client, "qa-approval");
	const started = await client.request("thread/start", makeThreadStartParams(scratch.cwd, "on-request"));
	const threadId = requiredThreadId(started);
	const mark = client.mark();
	await client.request("turn/start", { threadId, input: makeTextInput("run echo hi") }, 30000);
	const approval = await client.waitForMessage(
		(message) => message.method === "item/commandExecution/requestApproval" && message.params?.threadId === threadId,
		mark,
		60000,
	);
	const approvalIndex = client.messages.indexOf(approval);
	const earlyCompletion = client.messages.slice(mark, approvalIndex).some((message) => message.method === "turn/completed");
	if (earlyCompletion) throw new Error("turn completed before approval request was answered");
	client.write({ id: approval.id, result: { decision: "accept" } });
	await client.waitForMessage(
		(message) => message.method === "serverRequest/resolved" && message.params?.requestId === approval.id,
		approvalIndex,
		30000,
	);
	await client.waitForMessage(
		(message) => message.method === "turn/completed" && message.params?.threadId === threadId,
		approvalIndex,
		60000,
	);
	if (fake.requests.length < 2) throw new Error(`command loop did not continue after approval; requests=${fake.requests.length}`);
	if (!client.messages.slice(mark).some((message) => message.method === "item/completed" && message.params?.threadId === threadId)) {
		throw new Error("turn stream did not include item/completed");
	}
	const envelopes = client.assertServerEnvelopes();
	if (envelopes.serverRequestCount !== 1) {
		throw new Error(`expected one unstamped approval server request, got ${envelopes.serverRequestCount}`);
	}
	client.close();
	await fake.stop();
	pass(transcript, "approval");
} catch (error) {
	fail(transcript, "approval", error);
	process.exitCode = 1;
} finally {
	await cleanupAllAndWait();
	if (outPath) writeFileSync(outPath, `${transcript.join("\n")}\n`);
	if (transcript.length > 0) process.stdout.write(`${transcript.join("\n")}\n`);
	process.exit(process.exitCode ?? 0);
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}
