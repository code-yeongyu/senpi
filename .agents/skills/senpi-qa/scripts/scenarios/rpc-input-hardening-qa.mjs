#!/usr/bin/env node

import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const evidenceFlagIndex = process.argv.indexOf("--evidence");
const label =
	evidenceFlagIndex >= 0 ? process.argv[evidenceFlagIndex + 1] : "rpc-input-hardening";
if (!label) throw new Error("--evidence requires a value");

const root = repoRoot();
const checks = createChecks("rpc-input-hardening-qa.mjs");
const guard = guardRealAuth();
const box = makeSandbox(label);
const evidence = evidenceDir(label);
const server = await startFakeModelServer({ turns: [{ text: "RPC_INPUT_HARDENING_OK" }] });
writeMockModelsJson(box.agentDir, server, "anthropic-messages");

const startupTimeoutMs = 240_000;
const maxMessageCharacters = 1_000_000;
const maxLineCharacters = 16 * 1024 * 1024;

function waitForParseError(client, afterIndex) {
	const existing = client.events
		.slice(afterIndex)
		.find(
			(event) =>
				event.message.type === "response" &&
				event.message.command === "parse" &&
				event.message.success === false,
		);
	if (existing) return Promise.resolve(existing.message);
	return client
		.waitFor(
			(event) =>
				event.message.type === "response" &&
				event.message.command === "parse" &&
				event.message.success === false,
			startupTimeoutMs,
		)
		.then((event) => event.message);
}

async function writeChunk(client, chunk) {
	if (!client.child.stdin.write(chunk)) await once(client.child.stdin, "drain");
}

async function verifyNullRecovery(client, expectedMode) {
	const afterIndex = client.events.length;
	const parseErrorPromise = waitForParseError(client, afterIndex);
	await writeChunk(client, "null\n");
	const parseError = await parseErrorPromise;
	const protocol = await client.send({ type: "get_protocol_info" }, startupTimeoutMs);
	checks.ok(
		`${expectedMode} null input rejected`,
		parseError.error === "RPC command must be a JSON object.",
		JSON.stringify(parseError),
	);
	checks.ok(
		`${expectedMode} host remains responsive`,
		protocol.success === true && protocol.data?.mode === expectedMode,
		JSON.stringify(protocol),
	);
	return { parseError, protocol };
}

installCleanupHooks();
const classicClient = new TargetRpcClient({
	env: hermeticEnv(box.env),
	cwd: box.cwd,
	targetRoot: root,
});
let multiClient;
try {
	await classicClient.send(
		{ type: "set_model", provider: "anthropic", modelId: "mock-claude" },
		startupTimeoutMs,
	);
	const classicNull = await verifyNullRecovery(classicClient, "classic");

	const settledPromise = classicClient.waitFor(
		(event) => event.message.type === "agent_settled",
		startupTimeoutMs,
	);
	const maxMessageAccepted = await classicClient.send(
		{ type: "prompt", message: "\0".repeat(maxMessageCharacters) },
		startupTimeoutMs,
	);
	await settledPromise;
	checks.ok(
		"escaped maximum message accepted",
		maxMessageAccepted.success === true,
		JSON.stringify(maxMessageAccepted),
	);

	const oversizedAfterIndex = classicClient.events.length;
	const oversizedErrorPromise = waitForParseError(classicClient, oversizedAfterIndex);
	await writeChunk(classicClient, '{"type":"oversized","padding":"');
	await writeChunk(classicClient, "x".repeat(maxLineCharacters + 1));
	await writeChunk(classicClient, '"}\n');
	const oversizedError = await oversizedErrorPromise;
	const resynchronized = await classicClient.send({ type: "get_protocol_info" }, startupTimeoutMs);
	checks.ok(
		"oversized record rejected once",
		oversizedError.error === `RPC input line exceeds ${maxLineCharacters} characters.`,
		JSON.stringify(oversizedError),
	);
	checks.ok(
		"classic framing resynchronized",
		resynchronized.success === true && resynchronized.data?.mode === "classic",
		JSON.stringify(resynchronized),
	);

	await classicClient.close();
	multiClient = new TargetRpcClient({
		env: hermeticEnv(box.env),
		cwd: box.cwd,
		targetRoot: root,
		extraArgs: ["--multi-session"],
	});
	const multiNull = await verifyNullRecovery(multiClient, "multi");
	checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);

	writeFileSync(
		join(evidence, "rpc-input-hardening.json"),
		JSON.stringify(
			{
				classicNull,
				maxMessageCharacters,
				maxMessageAccepted,
				maxLineCharacters,
				oversizedError,
				resynchronized,
				multiNull,
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(evidence, "RPC-INPUT-HARDENING.md"),
		[
			"# RPC Input Hardening QA",
			"",
			"- PASS: classic and multi-session hosts reject `null` and remain responsive.",
			"- PASS: a one-million-character message with worst-case JSON escaping is accepted.",
			"- PASS: a record above 16 MiB emits one parse error and the next JSONL record succeeds.",
			"- PASS: real auth remains unchanged.",
			"",
		].join("\n"),
	);
	process.stderr.write(`evidence: ${evidence}\n`);
} finally {
	await classicClient.close();
	await multiClient?.close();
	await server.stop();
	box.cleanup();
}

process.exit(checks.finish() ? 0 : 1);
