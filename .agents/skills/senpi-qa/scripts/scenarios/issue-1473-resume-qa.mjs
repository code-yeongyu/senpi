// Real CLI / local HTTP provider proof for #1473. No real provider or credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { RpcClient } from "../lib/rpc-client.mjs";

installCleanupHooks();
const guard = guardRealAuth();
const box = makeSandbox("pr1473-resume-qa");
const evidence = evidenceDir(process.argv[2] ?? "pr1473-resume-cli");
const server = await startFakeModelServer({
	turns: [
		{ text: "PR1473_SOURCE_READY" },
		{ text: "PR1473_SOURCE_SURVIVED" },
		{ text: "PR1473_DESTINATION_READY" },
	],
});
writeMockModelsJson(box.agentDir, server, "openai-completions", { contextWindow: 100_000 });
writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({
	compaction: { enabled: false },
	retry: { enabled: false, modelFallback: false },
}));
const shutdown = join(box.dir, "shutdown");
const extension = join(box.dir, "lifecycle.mjs");
writeFileSync(extension, `
import { appendFileSync } from "node:fs";
export default function(pi) {
 pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(shutdown)}, event.reason + "\\n"));
}`);
const env = hermeticEnv(box.env);
for (const name of Object.keys(env)) {
	if (name.startsWith("SENPI_RPC_HOST_") || name.startsWith("SENPI_RPC_INTERNAL_KEY")) delete env[name];
}
const client = new RpcClient({
	env,
	cwd: box.cwd,
	extraArgs: [
		"--provider", "mock", "--model", "mock-model",
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
		"--extension", extension,
	],
});
const exited = once(client.child, "close");
const checks = [];

async function prompt(message, marker) {
	client.events.length = 0;
	const settled = client.waitForEvent((event) => event.type === "agent_settled");
	const response = await client.send({ type: "prompt", message, sessionTitlePrompt: false });
	assert.equal(response.success, true);
	await settled;
	const last = await client.send({ type: "get_last_assistant_text" });
	assert.equal(last.data.text, marker);
}

function target(path, id, text) {
	const timestamp = new Date(0).toISOString();
	const entries = [
		{ type: "session", version: 3, id, cwd: box.cwd, timestamp },
		{ type: "thinking_level_change", id: "thinking", parentId: null, timestamp, thinkingLevel: "off" },
		{ type: "message", id: "user", parentId: "thinking", timestamp,
			message: { role: "user", content: text, timestamp: 0 } },
	];
	// Deliberately unterminated: rejected resume must not even append a newline.
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

try {
	assert.equal((await client.send({ type: "get_state" })).success, true);
	await prompt("prepare source", "PR1473_SOURCE_READY");
	const before = (await client.send({ type: "get_state" })).data;
	const sourceBytes = readFileSync(before.sessionFile);
	const path = join(box.dir, "rejected.jsonl");
	// Same persisted ID exercises the shared-resource cleanup risk through the real CLI too.
	target(path, before.sessionId, "restored context ".repeat(40_000));
	const bytes = readFileSync(path);
	client.events.length = 0;
	const rejected = await client.send({ type: "switch_session", sessionPath: path });
	assert.equal(rejected.success, false);
	assert.equal(rejected.errorCode, "model_usability_budget");
	assert.equal(rejected.errorData.admission, "resume");
	assert.deepEqual(readFileSync(path), bytes);
	assert.deepEqual(readFileSync(before.sessionFile), sourceBytes);
	assert.equal(existsSync(shutdown), false);
	assert.equal(client.events.some((event) => event.type === "session_replaced"), false);
	const retained = (await client.send({ type: "get_state" })).data;
	assert.equal(retained.sessionId, before.sessionId);
	assert.equal(retained.sessionFile, before.sessionFile);
	await prompt("continue source", "PR1473_SOURCE_SURVIVED");
	checks.push("rejected resume: exact source and target bytes, no shutdown or replacement, source prompt completed");

	const acceptedPath = join(box.dir, "accepted.jsonl");
	const acceptedId = randomUUID();
	target(acceptedPath, acceptedId, "small accepted history");
	assert.equal((await client.send({ type: "switch_session", sessionPath: acceptedPath })).success, true);
	assert.equal((await client.send({ type: "get_state" })).data.sessionId, acceptedId);
	assert.equal(readFileSync(shutdown, "utf8"), "resume\n");
	await prompt("continue destination", "PR1473_DESTINATION_READY");
	const persisted = readFileSync(acceptedPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
	assert.equal(persisted.find((entry) => entry.id === "user")?.message.content, "small accepted history");
	assert.ok(persisted.some((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return false;
		const content = entry.message.content;
		return typeof content === "string" ? content === "continue destination"
			: content.some((part) => part.type === "text" && part.text === "continue destination");
	}));
	checks.push("accepted resume: one shutdown, unterminated history retained and destination prompt persisted");
	assert.equal(server.requests.length, 3);
	guard.assertUnchanged();
	writeFileSync(join(evidence, "result.json"), JSON.stringify({
		pass: true,
		checks,
		localProviderRequests: server.requests.length,
		realAuthUnchanged: true,
	}, null, 2));
	for (const check of checks) console.log(`PASS ${check}`);
	console.log(`PASS isolated CLI QA: ${evidence}`);
} finally {
	client.close();
	const deadline = setTimeout(() => client.child.kill("SIGKILL"), 10_000);
	try {
		await exited;
	} finally {
		clearTimeout(deadline);
		await server.stop();
		box.cleanup();
		guard.assertUnchanged();
	}
}
