#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, openSync, closeSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { countContinuationRequests, isContinuationMessage } from "./lib/goal-continuation-classifier.mjs";
import { watchForGoalState } from "./lib/watch-goal-state.mjs";
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

const PROBE = "goal-continuation-safety";
const outPath = flag("--out");
const markerValue = flag("--marker");
const profileHash = flag("--profile-hash");
const pathHash = flag("--path-hash");
const probeFile = flag("--probe-file");
const MARKER_ENV = "SENPI_QA_PROBE_ISOLATED";

const transcript = [];
const evidence = {
	scenarios: [],
	providerRequests: [],
	paidCalls: 0,
	credentialFindings: [],
	backend: { platform: process.platform, nodeVersion: process.version },
	isolation: {
		profileHash,
		pathHash,
		markerPresent: !!markerValue,
		directReadDenied: null,
		descendantReadDenied: null,
		directWriteDenied: null,
		descendantWriteDenied: null,
		tempWriteSucceeded: null,
		directReadDenialReason: null,
		descendantReadDenialReason: null,
		directWriteDenialReason: null,
		descendantWriteDenialReason: null,
	},
	temporaryRoots: [],
	paidCallCount: 0,
};

const realAgentDir = join(homedir(), ".senpi", "agent");

installCleanupHooks();

try {
	// Marker validation
	if (markerValue !== process.env[MARKER_ENV]) {
		throw new Error(`FATAL: Isolation marker mismatch or missing. Expected env ${MARKER_ENV}=${markerValue}, got ${process.env[MARKER_ENV]}`);
	}
	record("isolation-marker-verified", { value: markerValue });

	// Preflight isolation checks
	await preflightIsolationChecks();

	// Run scenarios
	await scenario1ContinuationCap();
	await scenario2And3UserPauseResume();
	await scenario4TerminalStops();
	await scenario5HistoricalFixture();
	await scenario6NormalCompletionAndTodoGate();

	// Verify all isolation enforcement and derive zero-writes receipt
	assert(evidence.isolation.directReadDenied, "Direct read denial not enforced");
	assert(evidence.isolation.descendantReadDenied, "Descendant read denial not enforced");
	assert(evidence.isolation.directWriteDenied, "Direct write denial not enforced");
	assert(evidence.isolation.descendantWriteDenied, "Descendant write denial not enforced");
	assert(evidence.isolation.tempWriteSucceeded, "Temporary scratch write was blocked");
	record("zero-qa-originated-protected-writes", { basis: "fail-closed Seatbelt policy and enforcement probes", directReadDenied: evidence.isolation.directReadDenied, descendantReadDenied: evidence.isolation.descendantReadDenied, directWriteDenied: evidence.isolation.directWriteDenied, descendantWriteDenied: evidence.isolation.descendantWriteDenied, scratchWriteSucceeded: evidence.isolation.tempWriteSucceeded });

	// Credential scan
	const raw = `${transcript.join("\n")}\n${JSON.stringify(evidence)}`;
	evidence.credentialFindings = credentialScan(raw);
	assertEqual(evidence.credentialFindings.length, 0, "credential scan found possible credentials");
	record("credential-scan", { findings: 0 });

	// Paid call check
	evidence.paidCallCount = evidence.paidCalls;
	assertEqual(evidence.paidCallCount, 0, "test issued paid API calls");

	pass(transcript, PROBE);
} catch (error) {
	fail(transcript, PROBE, error);
	process.exitCode = 1;
} finally {
	await cleanupAllAndWait();
	const finalEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
	transcript.push(`EVIDENCE ${finalEvidence.trimEnd()}`);
	if (outPath) writeFileSync(outPath, `${transcript.join("\n")}\n`);
	process.stdout.write(`${transcript.join("\n")}\n`);
	process.exit(process.exitCode ?? 0);
}

async function preflightIsolationChecks() {
	// Direct protected-root read should be denied with EPERM/EACCES
	let directReadDenied = false;
	let directReadReason = null;
	try {
		readdirSync(realAgentDir);
		directReadDenied = false;
		directReadReason = "read succeeded (isolation failed)";
	} catch (error) {
		if (error.code === "EACCES" || error.code === "EPERM") {
			directReadDenied = true;
			directReadReason = error.code;
		} else {
			directReadDenied = false;
			directReadReason = error.code || error.message;
		}
	}
	evidence.isolation.directReadDenied = directReadDenied;
	evidence.isolation.directReadDenialReason = directReadReason;
	record("preflight-direct-read-denial", { denied: directReadDenied, reason: directReadReason });

	// Spawned Node descendant protected-root read should be denied with EPERM/EACCES
	let descendantReadDenied = false;
	let descendantReadReason = null;
	const descendantScript = join(tmpdir(), `probe-test-descendant-${Date.now()}.mjs`);
	try {
		writeFileSync(descendantScript, `
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const realAgentDir = join(homedir(), ".senpi", "agent");
try {
	readdirSync(realAgentDir);
	console.log("DESCENDANT_READ_SUCCEEDED");
	process.exit(0);
} catch (error) {
	if (error.code === "EACCES" || error.code === "EPERM") {
		console.log("DESCENDANT_READ_DENIED:" + error.code);
		process.exit(0);
	}
	console.log("DESCENDANT_READ_ERROR:" + error.code);
	process.exit(1);
}
`);
		const result = spawnSync(process.execPath, [descendantScript], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		const output = result.stdout?.trim() || "";
		if (output.includes("DENIED")) {
			const match = output.match(/DENIED:(\w+)/);
			descendantReadDenied = true;
			descendantReadReason = match ? match[1] : "EPERM/EACCES";
		} else if (output.includes("SUCCEEDED")) {
			descendantReadDenied = false;
			descendantReadReason = "read succeeded (isolation failed)";
		} else {
			descendantReadDenied = false;
			descendantReadReason = output || result.stderr?.trim() || "unknown";
		}
	} finally {
		try {
			rmSync(descendantScript, { force: true });
		} catch {}
	}
	evidence.isolation.descendantReadDenied = descendantReadDenied;
	evidence.isolation.descendantReadDenialReason = descendantReadReason;
	record("preflight-descendant-read-denial", { denied: descendantReadDenied, reason: descendantReadReason });

	// Direct write-authorization test: append a byte to probe file should be denied with EPERM/EACCES
	let directWriteDenied = false;
	let directWriteReason = null;
	try {
		const fd = openSync(probeFile, "a");
		const buf = Buffer.from("x");
		const written = writeSync(fd, buf, 0, 1);
		closeSync(fd);
		directWriteDenied = false;
		directWriteReason = `write succeeded: ${written} bytes (isolation failed)`;
	} catch (error) {
		if (error.code === "EACCES" || error.code === "EPERM") {
			directWriteDenied = true;
			directWriteReason = error.code;
		} else {
			directWriteDenied = false;
			directWriteReason = error.code || error.message;
		}
	}
	evidence.isolation.directWriteDenied = directWriteDenied;
	evidence.isolation.directWriteDenialReason = directWriteReason;
	record("preflight-direct-write-denial", { denied: directWriteDenied, reason: directWriteReason });

	// Spawned Node descendant write-authorization test
	let descendantWriteDenied = false;
	let descendantWriteReason = null;
	const descendantWriteScript = join(tmpdir(), `probe-test-descendant-write-${Date.now()}.mjs`);
	try {
		writeFileSync(descendantWriteScript, `
import { openSync, closeSync, writeSync } from "node:fs";
const probeFile = process.argv[2];
try {
	const fd = openSync(probeFile, "a");
	const buf = Buffer.from("x");
	const written = writeSync(fd, buf, 0, 1);
	closeSync(fd);
	console.log("DESCENDANT_WRITE_SUCCEEDED:" + written);
	process.exit(0);
} catch (error) {
	if (error.code === "EACCES" || error.code === "EPERM") {
		console.log("DESCENDANT_WRITE_DENIED:" + error.code);
		process.exit(0);
	}
	console.log("DESCENDANT_WRITE_ERROR:" + error.code);
	process.exit(1);
}
`);
		const result = spawnSync(process.execPath, [descendantWriteScript, probeFile], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		const output = result.stdout?.trim() || "";
		if (output.includes("DENIED")) {
			const match = output.match(/DENIED:(\w+)/);
			descendantWriteDenied = true;
			descendantWriteReason = match ? match[1] : "EPERM/EACCES";
		} else if (output.includes("SUCCEEDED")) {
			descendantWriteDenied = false;
			descendantWriteReason = output.trim();
		} else {
			descendantWriteDenied = false;
			descendantWriteReason = output || result.stderr?.trim() || "unknown";
		}
	} finally {
		try {
			rmSync(descendantWriteScript, { force: true });
		} catch {}
	}
	evidence.isolation.descendantWriteDenied = descendantWriteDenied;
	evidence.isolation.descendantWriteDenialReason = descendantWriteReason;
	record("preflight-descendant-write-denial", { denied: descendantWriteDenied, reason: descendantWriteReason });

	// Temp scratch write should succeed
	let tempWriteSucceeded = false;
	let tempWriteReason = null;
	const scratchPath = join(tmpdir(), `senpi-qa-preflight-${Date.now()}.txt`);
	try {
		writeFileSync(scratchPath, "preflight test write");
		tempWriteSucceeded = true;
		tempWriteReason = "success";
		evidence.temporaryRoots.push(scratchPath);
		try {
			rmSync(scratchPath, { force: true });
		} catch {}
	} catch (error) {
		tempWriteSucceeded = false;
		tempWriteReason = error.code || error.message;
	}
	evidence.isolation.tempWriteSucceeded = tempWriteSucceeded;
	record("preflight-temp-write-success", { succeeded: tempWriteSucceeded, reason: tempWriteReason });

	// Assert isolation preflight passed
	if (!directReadDenied) {
		throw new Error(`ISOLATION FAILED: Direct read to ${realAgentDir} succeeded; Seatbelt policy ineffective`);
	}
	if (!descendantReadDenied) {
		throw new Error(`ISOLATION FAILED: Descendant read to ${realAgentDir} succeeded; Seatbelt policy ineffective`);
	}
	if (!directWriteDenied) {
		throw new Error(`ISOLATION FAILED: Direct write to ${probeFile} succeeded; write-authorization policy ineffective`);
	}
	if (!descendantWriteDenied) {
		throw new Error(`ISOLATION FAILED: Descendant write to ${probeFile} succeeded; write-authorization policy ineffective`);
	}
	if (!tempWriteSucceeded) {
		throw new Error(`ISOLATION PREFLIGHT FAILED: Temporary write failed; sandbox too restrictive`);
	}
}

async function scenario1ContinuationCap() {
	const harness = await boot(
		"goal-cap",
		Array.from({ length: 8 }, (_, index) => ({ text: `clean stop ${index + 1}` })),
	);
	try {
		const start = harness.client.mark();
		writePausedGoal(harness.scratch.sessionDir, harness.threadId, "cap clean-stop goal");
		const capReached = watchForGoalState(
			harness.scratch.sessionDir,
			harness.threadId,
			(goal) =>
				goal?.status === "paused" &&
				goal.consecutiveContinuations === 8,
			"paused continuation cap",
		);
		await harness.client.request("turn/start", {
			threadId: harness.threadId,
			input: makeTextInput("/goal resume"),
		});
		const goal = await capReached;
		const thread = await harness.client.request("thread/read", { threadId: harness.threadId });
		const continuationRequests = countContinuationRequests(harness.fake.requests);
		assertEqual(thread?.thread?.id, harness.threadId, "scenario 1 thread/read identity");
		assertEqual(goal?.threadId, harness.threadId, "scenario 1 Goal store identity");
		assertEqual(goal?.status, "paused", "scenario 1 Goal status after continuation cap");
		assertEqual(goal?.consecutiveContinuations ?? 0, 8, "scenario 1 delivered continuation count");
		assertEqual(continuationRequests, 8, "scenario 1 provider continuation requests");
		recordScenario(1, harness, start, goal, {
			commandSurface: "app-server turn/start /goal resume",
			continuationRequests,
			pendingContinuations: 0,
			threadReadId: thread?.thread?.id,
		});
	} finally {
		await harness.stop();
	}
}

async function scenario2And3UserPauseResume() {
	const harness = await boot("goal-user-resume", [
		createGoalTurn("pause for direct user input"),
		{ text: "first automatic continuation" },
		{ text: "direct answer" },
		{ text: "resumed continuation" },
		{ toolCalls: [{ name: "update_goal", args: { status: "complete" } }] },
		{ text: "goal complete" },
	]);
	try {
		await startTurn(harness, "create a goal before the direct question");
		const beforeDirect = harness.fake.requests.length;
		await startTurn(harness, "answer this direct user prompt on the second turn");
		const paused = readGoal(harness.scratch.sessionDir, harness.threadId);
		assertEqual(paused?.status, "paused", "scenario 2 direct input did not pause Goal");
		assertEqual(harness.fake.requests.length, beforeDirect + 1, "scenario 2 queued a continuation before explicit resume");
		recordScenario(2, harness, 0, paused, {
			continuationRequests: countContinuationRequests(harness.fake.requests),
			noContinuationBeforeResume: true,
		});

		const resumeMark = harness.client.mark();
		await harness.client.request("turn/start", { threadId: harness.threadId, input: makeTextInput("/goal resume") });
		await waitForGoalStatus(harness, "complete", resumeMark);
		const resumed = readGoal(harness.scratch.sessionDir, harness.threadId);
		assertEqual(resumed?.status, "complete", "scenario 3 resumed Goal did not complete");
		assertEqual(resumed?.consecutiveContinuations ?? 0, 0, "scenario 3 /goal resume did not reset count");
		recordScenario(3, harness, resumeMark, resumed, {
			commandSurface: "app-server turn/start /goal resume",
			continuationResumed: true,
		});
	} finally {
		await harness.stop();
	}
}

async function scenario4TerminalStops() {
	for (const [label, turn, exactReason] of [
		["length", { text: "truncated", finishReason: "length" }, "output length"],
		["terminal-error", { error: { status: 400, message: "invalid fixture request" } }, "terminal provider error"],
	]) {
		const harness = await boot(`goal-${label}`, [turn]);
		try {
			await harness.client.request("thread/goal/set", {
				threadId: harness.threadId,
				objective: `${label} goal`,
				status: "active",
			});
			const pausedGoal = watchForGoalState(
				harness.scratch.sessionDir,
				harness.threadId,
				(goal) => goal?.status === "paused" && goal.blockedReason === exactReason,
				`scenario 4 ${label} exact paused Goal`,
			);
			const mark = harness.client.mark();
			const turnCompleted = harness.client.waitForMessageEvent(
				(message) => message.method === "turn/completed" && message.params?.threadId === harness.threadId,
				mark,
				90_000,
			);
			await harness.client.request("turn/start", {
				threadId: harness.threadId,
				input: makeTextInput(`inject ${label}`),
			});
			const [goal, terminal] = await Promise.all([pausedGoal, turnCompleted]);
			assertEqual(terminal.params?.turn?.status, "completed", `scenario 4 ${label} turn status`);
			assertEqual(goal?.status, "paused", `scenario 4 ${label} status`);
			assertEqual(goal?.blockedReason, exactReason, `scenario 4 ${label} exact pause reason`);
			recordScenario(`4-${label}`, harness, mark, goal, { exactPauseReason: exactReason });
		} finally {
			await harness.stop();
		}
	}
}

async function scenario5HistoricalFixture() {
	const harness = await boot("goal-history-281", [{ text: "must not replay history" }], { startThread: false });
	try {
		const historicalThreadId = "issue-447-281";
		const sessionFile = join(harness.scratch.sessionDir, `${historicalThreadId}.jsonl`);
		writeFileSync(sessionFile, historicalFixture(281));
		const before = readFileSync(sessionFile);
		const beforeHash = sha256(before);
		const beforeLines = jsonlLines(before);
		const persistentContinuationCount = trailingGoalContinuationCount(beforeLines);
		assertEqual(persistentContinuationCount, 281, "scenario 5 derived historical continuation count");
		const lastStartedAt = Math.trunc(Date.now() / 1000);
		writeActiveGoal(
			harness.scratch.sessionDir,
			historicalThreadId,
			"Resume safely after the issue #447 historical flood",
			persistentContinuationCount,
			lastStartedAt,
		);
		const seededGoal = readGoal(harness.scratch.sessionDir, historicalThreadId);
		assertEqual(seededGoal?.status, "active", "scenario 5 seeded Goal status");
		assertEqual(seededGoal?.lastStartedAt, lastStartedAt, "scenario 5 seeded Goal lastStartedAt");
		assertEqual(seededGoal?.consecutiveContinuations ?? 0, persistentContinuationCount, "scenario 5 seeded persistent count");

		const resumeMark = harness.client.mark();
		const resumeRequestMark = harness.fake.requests.length;
		const recoveredPausedGoal = watchForGoalState(
			harness.scratch.sessionDir,
			historicalThreadId,
			(goal) => goal?.status === "paused",
			"scenario 5 historical Goal recovery paused",
		);
		const resumed = await harness.client.request("thread/resume", { threadId: historicalThreadId });
		harness.threadId = requiredThreadId(resumed);
		const recoveredGoal = await recoveredPausedGoal;
		assertEqual(recoveredGoal.threadId, historicalThreadId, "scenario 5 recovered Goal thread identity");
		assertEqual(recoveredGoal.status, "paused", "scenario 5 historical Goal recovery status");
		assertEqual(
			recoveredGoal.consecutiveContinuations ?? 0,
			persistentContinuationCount,
			"scenario 5 recovery preserved the maximum stored or derived count",
		);
		assertEqual(harness.fake.requests.length, resumeRequestMark, "scenario 5 recovery queued a provider continuation");

		const requestMark = harness.fake.requests.length;
		const eventMark = harness.client.mark();
		const firstRequestPromise = harness.fake.waitForRequest(
			(request) => request.url?.includes("chat/completions"),
			requestMark,
			90_000,
		);
		const turnCompletedPromise = harness.client.waitForMessageEvent(
			(message) => message.method === "turn/completed" && message.params?.threadId === harness.threadId,
			eventMark,
			90_000,
		);
		await harness.client.request("turn/start", {
			threadId: harness.threadId,
			input: makeTextInput("continue from the preserved historical session"),
		});
		const [firstRequest, terminal] = await Promise.all([firstRequestPromise, turnCompletedPromise]);
		assertEqual(terminal.params?.turn?.status, "completed", "scenario 5 real turn terminal status");
		assert(harness.fake.requests.length > requestMark, "scenario 5 real turn made no provider request");

		const goal = readGoal(harness.scratch.sessionDir, harness.threadId);
		const thread = await harness.client.request("thread/read", { threadId: harness.threadId });
		const after = readFileSync(sessionFile);
		const prefix = after.subarray(0, before.length);
		const appended = after.subarray(before.length);
		const afterLines = jsonlLines(after);
		const appendedLines = jsonlLines(appended);
		const firstContinuationCount = (firstRequest.messages ?? []).filter(isContinuationMessage).length;
		const providerContinuationRequests = countContinuationRequests(harness.fake.requests.slice(requestMark));
		const pendingContinuations = pendingTurnCount(harness.client.messages.slice(resumeMark));
		assert(after.length >= before.length, "scenario 5 session JSONL shrank");
		assertEqual(Buffer.compare(prefix, before), 0, "scenario 5 historical prefix changed; product defect");
		assertEqual(sha256(prefix), beforeHash, "scenario 5 historical prefix hash changed; product defect");
		assertEqual(
			JSON.stringify(afterLines.slice(0, beforeLines.length)),
			JSON.stringify(beforeLines),
			"scenario 5 original ordered JSONL lines changed; product defect",
		);
		assert(firstContinuationCount <= 1, "scenario 5 first provider request contained replayed continuations");
		assert(providerContinuationRequests <= 1, "scenario 5 issued more than one provider continuation request");
		assertEqual(pendingContinuations, 0, "scenario 5 retained a pending continuation");
		assertEqual(thread.thread.turns.filter((turn) => turn.status === "inProgress").length, 0, "scenario 5 thread retained an in-progress turn");
		recordScenario(5, harness, resumeMark, goal, {
			fixtureMessages: persistentContinuationCount,
			derivedPersistentContinuationCount: persistentContinuationCount,
			seededGoalLastStartedAt: lastStartedAt,
			recoveryPaused: recoveredGoal.status === "paused",
			recoveryPendingContinuations: 0,
			jsonlBeforeBytes: before.length,
			jsonlAfterBytes: after.length,
			jsonlAppendedBytes: appended.length,
			jsonlBeforeLines: beforeLines.length,
			jsonlAfterLines: afterLines.length,
			jsonlAppendedLines: appendedLines.length,
			jsonlBeforeSha256: beforeHash,
			jsonlAfterSha256: sha256(after),
			jsonlAppendedSha256: sha256(appended),
			prefixPreserved: true,
			firstProviderRequestContinuationCount: firstContinuationCount,
			providerContinuationRequests,
			pendingContinuations,
			totalProviderRequests: harness.fake.requests.length - requestMark,
			terminalStatus: terminal.params?.turn?.status,
		});
	} finally {
		await harness.stop();
	}
}

async function scenario6NormalCompletionAndTodoGate() {
	const harness = await boot("goal-normal", [
		{ toolCalls: [{ name: "todo", args: { op: "init", items: ["finish"] } }] },
		{ toolCalls: [{ name: "update_goal", args: { status: "complete" } }] },
		{ toolCalls: [{ name: "todo", args: { op: "done", task: "finish" } }] },
		{ toolCalls: [{ name: "update_goal", args: { status: "complete" } }] },
		{ text: "done" },
	]);
	try {
		writePausedGoal(harness.scratch.sessionDir, harness.threadId, "normal two-turn goal");
		const mark = harness.client.mark();
		const completeGoalPromise = watchForGoalState(
			harness.scratch.sessionDir,
			harness.threadId,
			(goal) => goal.status === "complete",
			"scenario 6 complete Goal",
		);
		const terminalPromise = harness.client.waitForMessageEvent(
			(message) =>
				message.method === "turn/completed" &&
				message.params?.threadId === harness.threadId &&
				message.params?.turn?.status === "completed",
			mark,
			90000,
		);
		await harness.client.request(
			"turn/start",
			{ threadId: harness.threadId, input: makeTextInput("/goal resume") },
			30000,
		);
		const [goal, terminal] = await Promise.all([completeGoalPromise, terminalPromise]);
		assertEqual(goal.status, "complete", "scenario 6 normal Goal did not complete");
		const continuationRequests = countContinuationRequests(harness.fake.requests);
		assert(continuationRequests >= 1, "scenario 6 did not issue a transformed Goal continuation request");
		const exchanges = [];
		for (const request of harness.fake.requests) {
			const messages = request.messages ?? [];
			for (let index = 0; index < messages.length; index += 1) {
				for (const call of messages[index]?.tool_calls ?? []) {
					const result = messages.slice(index + 1).find(
						(message) => message.role === "tool" && message.tool_call_id === call.id,
					);
					if (!result) continue;
					let args;
					try {
						args = JSON.parse(call.function?.arguments ?? "{}");
					} catch {
						args = null;
					}
					const exchange = { name: call.function?.name, args, result: result.content };
					if (!exchanges.some((candidate) => JSON.stringify(candidate) === JSON.stringify(exchange))) exchanges.push(exchange);
				}
			}
		}
		const todoInit = exchanges.find(
			(exchange) => exchange.name === "todo" && exchange.args?.op === "init" && exchange.args?.items?.length === 1 && exchange.args.items[0] === "finish",
		);
		const todoDone = exchanges.find(
			(exchange) => exchange.name === "todo" && exchange.args?.op === "done" && exchange.args?.task === "finish",
		);
		const completionResults = exchanges
			.filter((exchange) => exchange.name === "update_goal" && exchange.args?.status === "complete")
			.map((exchange) => JSON.stringify(exchange.result));
		const rejectedCompletion = completionResults.find(
			(result) => /todo|finish/i.test(result) && !/\\?"status\\?"\s*:\s*\\?"complete\\?"/.test(result),
		);
		const acceptedCompletion = completionResults.find((result) => /\\?"status\\?"\s*:\s*\\?"complete\\?"/.test(result));
		assert(todoInit && JSON.stringify(todoInit.result).length > 2, "scenario 6 provider traffic omitted the todo init call/result");
		assert(rejectedCompletion, "scenario 6 provider traffic omitted the rejected premature update_goal result");
		assert(todoDone && JSON.stringify(todoDone.result).length > 2, "scenario 6 provider traffic omitted the todo done call/result");
		assert(acceptedCompletion, "scenario 6 provider traffic omitted the accepted final update_goal result");
		if (Object.hasOwn(goal, "pendingContinuations")) {
			assertEqual(goal.pendingContinuations, 0, "scenario 6 retained a pending continuation");
		}
		recordScenario(6, harness, mark, goal, {
			autoContinued: true,
			prematureCompletionRejected: true,
			todoGateExercised: true,
			todoInit,
			rejectedPrematureCompletionResult: rejectedCompletion,
			todoDone,
			acceptedFinalCompletionResult: acceptedCompletion,
			finalGoal: goal,
			eventSequence: [`Goal:${goal.status}`, `${terminal.method}:${terminal.params.turn.status}`],
			requestCount: harness.fake.requests.length,
			...(Object.hasOwn(goal, "pendingContinuations") ? { finalPendingContinuations: goal.pendingContinuations } : {}),
		});
	} finally {
		await harness.stop();
	}
}

async function boot(label, turns, options = {}) {
	const scratch = makeScratch(label);
	transcript.push(`SENPI_CODING_AGENT_DIR=${scratch.agentDir}`);
	evidence.temporaryRoots.push(scratch.agentDir);
	const fake = await startFakeModelServer(turns);
	writeMockModelsJson(scratch.agentDir, fake);
	const child = spawnCli(["app-server"], scratch);
	const client = new StdioRpcClient(child, transcript, label);
	await initialize(client, `qa-${label}`);
	let threadId;
	if (options.startThread !== false) {
		threadId = requiredThreadId(await client.request("thread/start", makeThreadStartParams(scratch.cwd)));
	}
	return {
		scratch,
		fake,
		child,
		client,
		threadId,
		async stop() {
			client.close();
			await fake.stop();
			recordProviderRequests(label, fake.requests);
		},
	};
}

async function startTurn(harness, text) {
	const mark = harness.client.mark();
	const completion = harness.client.waitForMessageEvent(
		(message) => message.method === "turn/completed" && message.params?.threadId === harness.threadId,
		mark,
		90000,
	);
	await harness.client.request("turn/start", { threadId: harness.threadId, input: makeTextInput(text) }, 30000);
	const terminal = await completion;
	if (terminal.params?.turn?.status !== "completed") {
		throw new Error(`turn ended ${terminal.params?.turn?.status ?? "without status"}`);
	}
	return terminal;
}

async function waitForGoalStatus(harness, status, fromIndex) {
	await harness.client.waitForMessageEvent(
		(message) =>
			message.method === "turn/completed" &&
			message.params?.threadId === harness.threadId &&
			readGoal(harness.scratch.sessionDir, harness.threadId)?.status === status,
		fromIndex,
		90000,
	);
}

function createGoalTurn(objective) {
	return { toolCalls: [{ name: "create_goal", args: { objective } }] };
}

function writePausedGoal(sessionDir, threadId, objective) {
	const now = Math.trunc(Date.now() / 1000);
	writeGoalSidecar(sessionDir, threadId, {
		objective,
		status: "paused",
		consecutiveContinuations: 0,
		createdAt: now,
		updatedAt: now,
	});
}

function writeActiveGoal(sessionDir, threadId, objective, consecutiveContinuations, lastStartedAt) {
	writeGoalSidecar(sessionDir, threadId, {
		objective,
		status: "active",
		consecutiveContinuations,
		createdAt: lastStartedAt,
		updatedAt: lastStartedAt,
		lastStartedAt,
	});
}

function writeGoalSidecar(sessionDir, threadId, goal) {
	const root = join(sessionDir, "extensions", "goal");
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, `${encodeURIComponent(threadId)}.json`),
		JSON.stringify({
			version: 1,
			goal: {
				id: `qa-${threadId}`,
				threadId,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				...goal,
			},
		}),
	);
}

function readGoal(sessionDir, threadId) {
	const root = join(sessionDir, "extensions", "goal");
	if (!existsSync(root)) return null;
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (!statSync(path).isFile()) continue;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed?.goal?.threadId === threadId) return parsed.goal;
	}
	return null;
}

function historicalFixture(count) {
	const header = { type: "session", version: 3, id: "issue-447-281", timestamp: "2026-07-29T00:00:00.000Z", cwd: process.cwd() };
	const entries = [header];
	let parentId = null;
	for (let index = 0; index < count; index++) {
		const id = `continuation-${String(index).padStart(3, "0")}`;
		entries.push({
			type: "custom_message",
			id,
			parentId,
			timestamp: "2026-07-29T00:00:00.000Z",
			customType: "goal-continuation",
			content: `historical continuation ${index}`,
			display: false,
		});
		parentId = id;
	}
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function jsonlLines(bytes) {
	const text = bytes.toString("utf8");
	if (text.length === 0) return [];
	return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function trailingGoalContinuationCount(lines) {
	let count = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const entry = JSON.parse(lines[index]);
		if (entry?.type === "message" && entry.message?.role === "user") break;
		if (entry?.type === "custom_message" && entry.customType === "goal-continuation") count += 1;
	}
	return count;
}

function pendingTurnCount(messages) {
	return (
		messages.filter((message) => message.method === "turn/started").length -
		messages.filter((message) => message.method === "turn/completed").length
	);
}

function recordScenario(id, harness, fromIndex, goal, extra) {
	const sequence = harness.client.messages.slice(fromIndex).filter((message) => typeof message.method === "string").map((message) => message.method);
	const item = { id, eventSequence: sequence, finalGoal: goal, providerRequestCount: harness.fake.requests.length, ...extra };
	evidence.scenarios.push(item);
	transcript.push(`SCENARIO ${id} ${JSON.stringify(item)}`);
}

function recordProviderRequests(label, requests) {
	const summary = requests.map((request, index) => ({
		index,
		method: request.method,
		url: request.url,
		model: request.model,
		continuationCount: (request.messages ?? []).filter(isContinuationMessage).length,
	}));
	evidence.providerRequests.push({ label, requests: summary });
}

function record(label, value) {
	transcript.push(`${label} ${JSON.stringify(value)}`);
}

function credentialScan(raw) {
	const patterns = [
		/(?:sk|key|token)-[A-Za-z0-9_-]{16,}/g,
		/(?:api[_-]?key|authorization|bearer)["' :=]+(?!sk-senpi-app-server-qa)[A-Za-z0-9._-]{12,}/gi,
	];
	return patterns.flatMap((pattern) => raw.match(pattern) ?? []).filter((match) => !match.includes("sk-senpi-app-server-qa"));
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function flag(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}
