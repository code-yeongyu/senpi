#!/usr/bin/env node
/**
 * Real RPC/CLI regression QA for #1329.
 *
 * Drives an idle `send_custom_message` triggerTurn through the source CLI and
 * asserts the local fake provider's direct-RPC and extension-produced wake
 * requests each contain both the extension hook marker and original trigger exactly once.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

const NORMAL_PROMPT = "issue-1329 normal";
const WAKE_PROMPT = "issue-1329 wake";
const EXTENSION_WAKE_PROMPT = "issue-1329 extension wake";
const HOOK_PREFIX = "issue-1329-hook:";
const SYSTEM_PREFIX = "issue-1329-system:";
const NORMAL_REPLY = "ISSUE_1329_NORMAL_REPLY";
const WAKE_REPLY = "ISSUE_1329_WAKE_REPLY";
const EXTENSION_WAKE_REPLY = "ISSUE_1329_EXTENSION_WAKE_REPLY";

function argument(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestMessageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : ""))
		.join("\n");
}

function countExactRequestMessage(messages, text) {
	return messages.filter((message) => requestMessageText(message) === text).length;
}

async function portIsReleased(port) {
	const probe = createServer();
	try {
		await new Promise((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", resolve);
		});
		return true;
	} catch {
		return false;
	} finally {
		await new Promise((resolve) => probe.close(() => resolve()));
	}
}

function writeProbeExtension(path, recordsPath) {
	writeFileSync(
		path,
		`import { appendFileSync } from "node:fs";

export default function issue1329Probe(pi) {
	pi.on("before_agent_start", (event) => {
		appendFileSync(${JSON.stringify(recordsPath)}, JSON.stringify({ event: "before_agent_start", prompt: event.prompt }) + "\\n");
		return {
			message: { customType: "issue-1329-hook", content: ${JSON.stringify(HOOK_PREFIX)} + event.prompt, display: false },
			systemPrompt: event.systemPrompt + "\\n" + ${JSON.stringify(SYSTEM_PREFIX)} + event.prompt,
		};
	});
	pi.registerCommand("issue-1329-extension-wake", {
		description: "Send the #1329 wake from the extension API.",
		handler: async () => {
			await pi.sendMessage(
				{ customType: "issue-1329-extension-trigger", content: ${JSON.stringify(EXTENSION_WAKE_PROMPT)}, display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});
}
`,
	);
}

function readProbeRecords(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function sanitizedRequests(requests) {
	return requests.map((request) => ({
		method: request.method,
		url: request.url,
		model: request.model,
		stream: request.stream,
		body: {
			model: request.body?.model,
			messages: Array.isArray(request.body?.messages)
				? request.body.messages.map((message) =>
						message?.role === "system"
							? {
									role: "system",
									containsIssue1329SystemMarker: requestMessageText(message).includes(SYSTEM_PREFIX),
								}
							: { role: message?.role, content: message?.content },
					)
				: [],
		},
		authorization: request.authorization ? "<redacted>" : null,
		apiKeyHeader: request.apiKeyHeader ? "<redacted>" : null,
	}));
}

async function main() {
	const selfTest = process.argv.includes("--self-test");
	const evidenceName = argument("--evidence") ?? (selfTest ? "issue-1329-self-test" : undefined);
	if (!evidenceName) throw new Error("--evidence <slug> is required unless --self-test is used");

	installCleanupHooks();
	const checks = createChecks("issue-1329-qa.mjs");
	const authGuard = guardRealAuth();
	const evidence = evidenceDir(evidenceName);
	const box = makeSandbox("issue-1329-qa");
	const extensionPath = join(box.dir, "issue-1329-probe.mjs");
	const recordsPath = join(box.dir, "issue-1329-probe.jsonl");
	let client;
	let server;
	let report = { scenario: "issue-1329-qa", selfTest, error: undefined };
	let serverPortReleased = false;

	try {
		writeProbeExtension(extensionPath, recordsPath);
		server = await startFakeModelServer({
			turns: [{ text: NORMAL_REPLY }, { text: WAKE_REPLY }, { text: EXTENSION_WAKE_REPLY }],
		});
		writeMockModelsJson(box.agentDir, server, "openai-completions");
		client = new TargetRpcClient({
			env: hermeticEnv(box.env),
			cwd: box.cwd,
			targetRoot: repoRoot(),
			extraArgs: ["--extension", extensionPath],
		});

		const selected = await client.send({ type: "set_model", provider: "mock", modelId: "mock-model" });
		checks.ok("source CLI selected the sandbox fake model", selected.success === true, JSON.stringify(selected));

		// Subscribe before each action so this scenario never depends on elapsed time.
		const firstSettled = client.waitFor((event) => event.message.type === "agent_settled");
		const firstIdle = client.waitFor((event) => event.message.type === "agent_idle");
		const prompted = await client.send({ type: "prompt", message: NORMAL_PROMPT });
		await firstSettled;
		await firstIdle;
		checks.ok("normal turn completed before the idle trigger", prompted.success === true, JSON.stringify(prompted));

		const wakeStarted = client.waitFor((event) => event.message.type === "agent_start");
		const wakeSettled = client.waitFor((event) => event.message.type === "agent_settled");
		const wakeIdle = client.waitFor((event) => event.message.type === "agent_idle");
		const woke = await client.send({
			type: "send_custom_message",
			customType: "issue-1329-trigger",
			content: WAKE_PROMPT,
			display: false,
			triggerTurn: true,
			deliverAs: "followUp",
		});
		await wakeStarted;
		await wakeSettled;
		await wakeIdle;
		checks.ok("direct RPC idle triggerTurn custom message completed", woke.success === true, JSON.stringify(woke));

		const extensionWakeStarted = client.waitFor((event) => event.message.type === "agent_start");
		const extensionWakeSettled = client.waitFor((event) => event.message.type === "agent_settled");
		const extensionWakeIdle = client.waitFor((event) => event.message.type === "agent_idle");
		const extensionCommand = await client.send({ type: "prompt", message: "/issue-1329-extension-wake" });
		await extensionWakeStarted;
		await extensionWakeSettled;
		await extensionWakeIdle;
		checks.ok("extension-produced idle triggerTurn completed", extensionCommand.success === true, JSON.stringify(extensionCommand));

		const records = readProbeRecords(recordsPath);
		const directWakeRequest = server.requests[1];
		const extensionWakeRequest = server.requests[2];
		const directWakeMessages = Array.isArray(directWakeRequest?.body?.messages) ? directWakeRequest.body.messages : [];
		const extensionWakeMessages = Array.isArray(extensionWakeRequest?.body?.messages)
			? extensionWakeRequest.body.messages
			: [];
		const directWakeWire = JSON.stringify(directWakeRequest?.body ?? {});
		const extensionWakeWire = JSON.stringify(extensionWakeRequest?.body ?? {});
		checks.ok("exactly three provider requests reached the local fake server", server.requests.length === 3, `count=${server.requests.length}`);
		checks.ok(
			"before_agent_start ran once for normal, direct RPC, and extension wake turns",
			JSON.stringify(records.map((record) => record.prompt)) ===
				JSON.stringify([NORMAL_PROMPT, WAKE_PROMPT, EXTENSION_WAKE_PROMPT]),
			JSON.stringify(records),
		);
		for (const [label, prompt, messages, wire] of [
			["direct RPC", WAKE_PROMPT, directWakeMessages, directWakeWire],
			["extension-produced", EXTENSION_WAKE_PROMPT, extensionWakeMessages, extensionWakeWire],
		]) {
			checks.ok(
				`actual ${label} wake request contains the original trigger exactly once`,
				countExactRequestMessage(messages, prompt) === 1,
				`count=${countExactRequestMessage(messages, prompt)}`,
			);
			checks.ok(
				`actual ${label} wake request contains the hook marker exactly once`,
				countExactRequestMessage(messages, `${HOOK_PREFIX}${prompt}`) === 1,
				`count=${countExactRequestMessage(messages, `${HOOK_PREFIX}${prompt}`)}`,
			);
			checks.ok(
				`actual ${label} wake request contains the hook system-prompt override`,
				wire.includes(`${SYSTEM_PREFIX}${prompt}`),
				"wire marker present",
			);
		}

		report = {
			scenario: "issue-1329-qa",
			selfTest,
			requestCount: server.requests.length,
			directRpcWakeRequestIndex: 1,
			extensionWakeRequestIndex: 2,
			requests: sanitizedRequests(server.requests),
			probeRecords: records,
			rpcEvents: client.events.map((event) => event.message.type),
			error: undefined,
		};
	} catch (error) {
		report = {
			...report,
			error: error instanceof Error ? error.message : String(error),
		};
		checks.ok("scenario completed", false, report.error);
	} finally {
		await client?.close();
		if (server) {
			await server.stop();
			serverPortReleased = await portIsReleased(server.port);
		}
		box.cleanup();
		const authUnchanged = authGuard.assertUnchanged();
		checks.ok("real auth unchanged", authUnchanged, authGuard.path);
		const cleanup = {
			clientClosed: client === undefined || client.child.exitCode !== null,
			serverPortReleased,
			sandboxRemoved: !existsSync(box.dir),
			realAuthUnchanged: authUnchanged,
		};
		writeFileSync(join(evidence, "issue-1329-qa.json"), JSON.stringify({ ...report, cleanup }, null, 2));
		writeFileSync(
			join(evidence, "README.md"),
			[
				"# Issue #1329 QA",
				"",
				"- Real source CLI in RPC mode against a local fake OpenAI server.",
				"- Direct-RPC and extension-produced wakes each have one original trigger, one hook marker, and the hook system override in their captured request.",
				"- `issue-1329-qa.json` contains sanitized request bodies, hook records, RPC events, and cleanup receipt.",
				"",
			].join("\n"),
		);
	}

	process.exitCode = checks.finish() ? 0 : 1;
}

await main();
