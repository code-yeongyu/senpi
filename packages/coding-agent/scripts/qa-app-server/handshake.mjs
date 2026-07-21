#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { cleanupAllAndWait, installCleanupHooks, makeScratch, makeThreadStartParams, spawnCli, startFakeModelServer, writeMockModelsJson } from "./lib/env.mjs";
import { fail, initialize, pass, requiredThreadId, StdioRpcClient } from "./lib/rpc.mjs";

const transcript = [];
const outPath = flag("--out");
installCleanupHooks();

try {
	const scratch = makeScratch("app-server-handshake");
	const fake = await startFakeModelServer([{ text: "unused" }]);
	writeMockModelsJson(scratch.agentDir, fake);
	const child = spawnCli(["app-server"], scratch);
	const client = new StdioRpcClient(child, transcript, "stdio");
	const init = await initialize(client, "qa-handshake");
	if (typeof init?.userAgent !== "string") throw new Error(`initialize result missing userAgent: ${JSON.stringify(init)}`);
	const thread = await client.request("thread/start", makeThreadStartParams(scratch.cwd));
	transcript.push(`threadId=${requiredThreadId(thread)}`);
	client.assertServerEnvelopes();
	client.close();
	await fake.stop();
	pass(transcript, "handshake");
} catch (error) {
	fail(transcript, "handshake", error);
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
