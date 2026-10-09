#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupAll,
	evidenceDir,
	installCleanupHooks,
	makeSandbox,
	realAuthPath,
	runCli,
	stripAnsi,
} from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const CONTEXT_WINDOW = 120_000;
const MAX_TOKENS = 8_000;
const FIRST_MARKER = "SENPI-QA-1524-FIRST";
const RESUME_MARKER = "SENPI-QA-1524-RESUMED";
const INFLATED_MARKER = "SENPI-QA-1524-INFLATED";
const INFLATE_ENTRIES = 60;
const INFLATE_CHUNK = "restored context ".repeat(600);

const results = [];
function check(label, passed, detail) {
	results.push({ label, passed, detail });
	console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function authFingerprint() {
	const path = realAuthPath();
	if (!existsSync(path)) return "absent";
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findSessionFile(sessionDir) {
	const found = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith(".jsonl")) found.push(full);
		}
	};
	if (existsSync(sessionDir)) walk(sessionDir);
	if (found.length !== 1) throw new Error(`expected exactly one session file, found ${found.length}`);
	return found[0];
}

function readEntries(sessionFile) {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

function inflateSession(sessionFile) {
	const entries = readEntries(sessionFile);
	const template = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
	if (!template) throw new Error("no user message entry to use as a template");
	let parentId = entries[entries.length - 1].id;
	const timestampBase = Date.now();
	const appended = [];
	for (let index = 0; index < INFLATE_ENTRIES; index++) {
		const id = `qa1524-${index}`;
		appended.push({
			...template,
			id,
			parentId,
			timestamp: new Date(timestampBase + index).toISOString(),
			message: {
				...template.message,
				role: "user",
				content: [{ type: "text", text: `${INFLATED_MARKER} ${index} ${INFLATE_CHUNK}` }],
				timestamp: timestampBase + index,
			},
		});
		parentId = id;
	}
	appendFileSync(sessionFile, `${appended.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return appended.length;
}

function estimateTokensFromWire(request) {
	const payload = request.messages ?? request.body?.messages ?? request.body?.input ?? [];
	return Math.ceil(JSON.stringify(payload).length / 4);
}

async function main() {
	installCleanupHooks();
	const authBefore = authFingerprint();
	const box = makeSandbox("senpi-qa-1524");
	const env = hermeticEnv(box.env);
	const server = await startFakeModelServer({
		turns: [{ text: FIRST_MARKER }, { text: RESUME_MARKER }, { text: RESUME_MARKER }],
	});
	const cliArgs = ["--print", "--provider", "mock", "--model", "mock-model"];
	let evidence = "";
	try {
		writeMockModelsJson(box.agentDir, server, "openai-completions", {
			contextWindow: CONTEXT_WINDOW,
			maxTokens: MAX_TOKENS,
		});

		const first = await runCli([...cliArgs, "start the session"], { env, cwd: box.cwd });
		check(
			"first turn completes",
			first.code === 0 && stripAnsi(first.stdout).includes(FIRST_MARKER),
			`exit ${first.code} ${stripAnsi(first.stderr).slice(0, 300)}`,
		);

		const sessionFile = findSessionFile(box.sessionDir);
		const inflated = inflateSession(sessionFile);
		const liveTokens = Math.ceil(
			JSON.stringify(readEntries(sessionFile).filter((entry) => entry.type === "message")).length / 4,
		);
		check(
			"restored context exceeds the model window",
			liveTokens > CONTEXT_WINDOW,
			`live ~${liveTokens} tokens vs window ${CONTEXT_WINDOW}`,
		);

		const requestsBefore = server.requests.length;
		const resumed = await runCli([...cliArgs, "--continue", "say the marker"], { env, cwd: box.cwd });
		const resumedOut = stripAnsi(resumed.stdout);
		check(
			"resumed turn completes instead of failing admission",
			resumed.code === 0 && resumedOut.includes(RESUME_MARKER),
			`exit ${resumed.code}`,
		);
		check(
			"no model usability budget error surfaced",
			!resumedOut.includes("ModelUsabilityBudgetError") && !stripAnsi(resumed.stderr).includes("cannot resume"),
			"",
		);

		const resumeRequests = server.requests.slice(requestsBefore);
		check("resumed turn reached the provider", resumeRequests.length > 0, `${resumeRequests.length} request(s)`);
		const wireTokens = resumeRequests.map(estimateTokensFromWire);
		const largest = Math.max(0, ...wireTokens);
		check(
			"outgoing request fits beside the reserved output budget",
			largest > 0 && largest <= CONTEXT_WINDOW - MAX_TOKENS,
			`largest ~${largest} tokens vs budget ${CONTEXT_WINDOW - MAX_TOKENS}`,
		);
		check("outgoing request is smaller than the restored context", largest < liveTokens, `${largest} < ${liveTokens}`);

		const afterEntries = readEntries(sessionFile);
		const preserved = afterEntries.filter(
			(entry) => entry.type === "message" && JSON.stringify(entry.message?.content ?? "").includes(INFLATED_MARKER),
		).length;
		check("recorded transcript is preserved", preserved === inflated, `${preserved}/${inflated} inflated entries on disk`);

		const reopened = await runCli([...cliArgs, "--continue", "say the marker again"], { env, cwd: box.cwd });
		check(
			"reopening the reduced session still works",
			reopened.code === 0 && stripAnsi(reopened.stdout).includes(RESUME_MARKER),
			`exit ${reopened.code}`,
		);
		const reductions = readEntries(sessionFile).filter(
			(entry) => entry.type === "compaction" && entry.details?.origin === "resume-admission",
		).length;
		check("reduction is recorded once, not repeated", reductions === 1, `${reductions} resume-admission entries`);

		evidence = [
			`window=${CONTEXT_WINDOW} maxTokens=${MAX_TOKENS}`,
			`restored live tokens ~${liveTokens}`,
			`outgoing request tokens ${JSON.stringify(wireTokens)}`,
			`inflated entries preserved ${preserved}/${inflated}`,
			`resume-admission entries ${reductions}`,
			"",
			"first turn stdout:",
			stripAnsi(first.stdout).trim(),
			"",
			"resumed turn stdout:",
			resumedOut.trim(),
		].join("\n");
	} finally {
		await server.stop();
		box.cleanup();
		cleanupAll();
	}

	const authAfter = authFingerprint();
	check("real auth file untouched", authBefore === authAfter, "");

	const dir = evidenceDir("issue1524-resume");
	mkdirSync(dir, { recursive: true });
	const failed = results.filter((entry) => !entry.passed);
	writeFileSync(
		join(dir, "qa-1524-resume.log"),
		[
			`# senpi-qa: #1524 oversized resume through the real CLI`,
			`# date: ${new Date().toISOString()}`,
			"",
			...results.map((entry) => `${entry.passed ? "PASS" : "FAIL"} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`),
			"",
			evidence,
			"",
			"cleanup: fake model server closed; sandbox removed; no tracked child left running",
		].join("\n"),
	);
	console.log(`evidence: ${join(dir, "qa-1524-resume.log")}`);
	if (failed.length > 0) {
		console.error(`${failed.length} check(s) failed`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	cleanupAll();
	process.exit(1);
});
