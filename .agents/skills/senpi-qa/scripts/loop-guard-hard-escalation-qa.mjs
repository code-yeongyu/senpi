#!/usr/bin/env node
/**
 * Real-CLI QA for loop-guard hard escalation.
 *
 * The fake model requests `todo view` nine times. Calls 1-6 execute, calls 7-9
 * return loop-guard errors, and the third blocked call queues a user-role wake
 * before a system abort. The next provider request completes with the final
 * marker. No real provider or credential is used.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { API_PRESETS, checkRealAuthUnchanged, hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const API = "openai-completions";
const FINAL_MARKER = "SENPI-QA-LOOP-GUARD-RECOVERED-73";

function collectJsonlFiles(root) {
	const files = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		const stat = statSync(path);
		if (stat.isDirectory()) files.push(...collectJsonlFiles(path));
		else if (name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

function requestMessages(request) {
	return Array.isArray(request.body?.messages) ? request.body.messages : [];
}

function userMessageCount(request) {
	return requestMessages(request).filter((message) => message?.role === "user").length;
}

function hasNovelUserMessage(finalRequest, priorRequest) {
	const prior = new Set(
		requestMessages(priorRequest)
			.filter((message) => message?.role === "user")
			.map((message) => JSON.stringify(message)),
	);
	return requestMessages(finalRequest)
		.filter((message) => message?.role === "user")
		.some((message) => !prior.has(JSON.stringify(message)));
}

function blockedCallCounts(requests) {
	const counts = new Set();
	for (const request of requests) {
		const serialized = JSON.stringify(requestMessages(request));
		for (const match of serialized.matchAll(/Loop guard blocked repeated call (\d+)/g)) {
			counts.add(Number(match[1]));
		}
	}
	return [...counts].sort((left, right) => left - right);
}

function portIsClosed(port) {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", () => resolve(true));
	});
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("loop-guard-hard-escalation-qa.mjs");
	const authGuard = guardRealAuth();
	const box = makeSandbox("loop-guard-hard-escalation");
	const evidencePath = evidenceDir("loop-guard-escalation");
	const repeatedTurns = Array.from({ length: 9 }, (_, index) => ({
		toolCalls: [{ id: `call_loop_guard_${index + 1}`, name: "todo", args: { op: "view" } }],
	}));
	const server = await startFakeModelServer({ turns: [...repeatedTurns, { text: FINAL_MARKER }] });
	let summary = { pass: false };
	try {
		const preset = API_PRESETS[API];
		writeMockModelsJson(box.agentDir, server, API);
		const result = await runCli(
			[
				"--provider",
				preset.provider,
				"--model",
				preset.modelId,
				"--no-context-files",
				"--no-extensions",
				"--print",
				"Follow the scripted model turns.",
			],
			{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 120_000 },
		);
		const counts = blockedCallCounts(server.requests);
		const finalRequest = server.requests.at(-1);
		const priorRequest = server.requests.at(-2);
		const userWakeQueued =
			finalRequest !== undefined &&
			priorRequest !== undefined &&
			userMessageCount(finalRequest) >= userMessageCount(priorRequest) &&
			hasNovelUserMessage(finalRequest, priorRequest);
		const sessionText = collectJsonlFiles(box.sessionDir)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");
		const escalationEntries = sessionText.match(/"customType":"loop-guard:escalation"/g)?.length ?? 0;
		const recoveryEntries = sessionText.match(/"customType":"loop-guard:recovery"/g)?.length ?? 0;
		const escalationLine = sessionText
			.split("\n")
			.find((line) => line.includes('"customType":"loop-guard:escalation"'));
		const escalationDetails = escalationLine === undefined ? undefined : JSON.parse(escalationLine).details;
		const escalatedBlockedCount = escalationDetails?.blockedCallCount;

		checks.ok("CLI completes after the hard stop", result.code === 0, `code=${result.code}`);
		checks.ok(
			"calls 7-9 are blocked in order",
			JSON.stringify(counts) === "[1,2]" && escalatedBlockedCount === 3,
			`providerResults=${JSON.stringify(counts)} escalation=${String(escalatedBlockedCount)}`,
		);
		checks.ok(
			"hard stop queues one provider-user recovery turn",
			userWakeQueued && recoveryEntries === 1,
			`requests=${server.requests.length} recoveryEntries=${recoveryEntries}`,
		);
		checks.ok("one escalation entry is persisted", escalationEntries === 1, `entries=${escalationEntries}`);
		checks.ok("wake turn reaches the final marker", result.stdout.includes(FINAL_MARKER), result.stdout.slice(-300));

		summary = {
			pass:
				result.code === 0 &&
				JSON.stringify(counts) === "[1,2]" &&
				escalatedBlockedCount === 3 &&
				userWakeQueued &&
				recoveryEntries === 1 &&
				escalationEntries === 1,
			exitCode: result.code,
			requestCount: server.requests.length,
			blockedCallCounts: counts,
			escalatedBlockedCount,
			userWakeQueued,
			escalationEntries,
			recoveryEntries,
			finalMarkerSeen: result.stdout.includes(FINAL_MARKER),
			stderrTail: result.stderr.slice(-500),
		};
	} finally {
		await server.stop();
		box.cleanup();
	}
	checks.ok("fake server port closed", await portIsClosed(server.port), String(server.port));
	checks.ok("sandbox removed", !existsSync(box.dir), box.dir);
	checkRealAuthUnchanged(checks, authGuard);
	writeFileSync(join(evidencePath, "hard-escalation-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	process.exit(checks.finish() ? 0 : 1);
}

await main();
