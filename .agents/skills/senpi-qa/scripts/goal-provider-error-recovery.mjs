#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";
import { RpcQaClient } from "./lib/rpc-qa-client.mjs";

const PROVIDER_ERROR_REASON = "provider error ended the turn (retries exhausted)";
const INTENTIONAL_REASON = "waiting on an explicit user decision";
const TURNS = [
	{ toolCalls: [{ id: "qa-create-goal", name: "create_goal", args: { objective: "Survive a provider outage" } }] },
	{ error: { status: 400, message: "SENPI_QA_TERMINAL_PROVIDER_ERROR" } },
	{ toolCalls: [{ id: "qa-get-reactivated-goal", name: "get_goal", args: {} }] },
	{
		toolCalls: [
			{
				id: "qa-intentional-block",
				name: "update_goal",
				args: { status: "blocked", reason: INTENTIONAL_REASON },
			},
		],
	},
	{ text: "SENPI-QA-INTENTIONAL-BLOCK-SET" },
	{ toolCalls: [{ id: "qa-get-still-blocked-goal", name: "get_goal", args: {} }] },
	{ text: "SENPI-QA-INTENTIONAL-BLOCK-PRESERVED" },
];

function flag(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function findJsonFiles(root) {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return findJsonFiles(path);
		return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
	});
}

function readGoal(agentDir) {
	const root = join(agentDir, "extensions", "goal");
	const files = findJsonFiles(root);
	if (files.length !== 1) throw new Error(`Expected one goal under ${root}, found ${files.length}`);
	const parsed = JSON.parse(readFileSync(files[0], "utf8"));
	const goal = parsed?.goal ?? parsed;
	if (!goal || typeof goal.status !== "string") throw new Error(`Invalid goal record in ${files[0]}`);
	return goal;
}

function toolGoal(events, toolCallId) {
	const event = events.find(
		(candidate) => candidate.type === "tool_execution_end" && candidate.toolCallId === toolCallId,
	);
	const text = event?.result?.content?.find((part) => part.type === "text")?.text;
	if (typeof text !== "string") throw new Error(`Missing result for ${toolCallId}`);
	const goal = JSON.parse(text)?.goal;
	if (!goal || typeof goal.status !== "string") throw new Error(`Invalid goal result for ${toolCallId}`);
	return goal;
}

function safeRequests(requests) {
	return requests.map((request, index) => ({
		index: index + 1,
		method: request.method,
		url: request.url,
		model: request.model,
		messageCount: Array.isArray(request.messages) ? request.messages.length : null,
	}));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runPrompt(client, message) {
	const afterIndex = client.events.length;
	const terminalPromise = client.waitForEvent(
		(event) => event.type === "agent_end" || event.type === "agent_aborted",
		afterIndex,
		60_000,
	);
	const acknowledgement = await client.send({ type: "prompt", message }, 15_000);
	return { acknowledgement, terminal: await terminalPromise };
}

async function main() {
	if (!process.argv.includes("--self-test")) {
		process.stderr.write("usage: goal-provider-error-recovery.mjs --self-test [--evidence SLUG]\n");
		process.exitCode = 2;
		return;
	}

	installCleanupHooks();
	const checks = createChecks("goal-provider-error-recovery.mjs --self-test");
	const evidence = evidenceDir(flag("--evidence") ?? "goal-provider-error-recovery");
	const authGuard = guardRealAuth();
	const box = makeSandbox("senpi-qa-goal-provider-error-recovery");
	const preset = API_PRESETS["openai-completions"];
	const observed = { terminals: [], goals: {}, requestCount: 0, localhostOnly: false };
	let server;
	let client;
	let rpcExitCode = null;
	let realAuthUnchanged = false;

	try {
		server = await startFakeModelServer({ turns: TURNS });
		writeMockModelsJson(box.agentDir, server, "openai-completions", {}, {
			retry: {
				enabled: false,
				maxRetries: 0,
				baseDelayMs: 0,
				provider: { maxRetries: 0, maxRetryDelayMs: 0 },
				fallbackChains: {},
			},
		});
		client = new RpcQaClient({
			env: hermeticEnv(box.env),
			cwd: box.cwd,
			extraArgs: ["--provider", preset.provider, "--model", preset.modelId],
		});

		const state = await client.send({ type: "get_state" });
		checks.ok("RPC booted in the isolated sandbox", state.success === true && state.command === "get_state");

		const first = await runPrompt(client, "Create the scripted recovery goal and begin it.");
		observed.terminals.push(first.terminal.type);
		checks.ok(
			"provider-error turn ended through agent_end",
			first.acknowledgement.success === true && first.terminal.type === "agent_end",
		);
		observed.goals.providerError = readGoal(box.agentDir);
		checks.ok("provider error stopped after exactly two localhost requests", server.requests.length === 2);
		checks.ok(
			"provider error persisted the mechanical blocked reason",
			observed.goals.providerError.status === "blocked" &&
				observed.goals.providerError.blockedReason === PROVIDER_ERROR_REASON,
		);

		const second = await runPrompt(
			client,
			"Retry the goal now, inspect its status, then apply the scripted intentional block.",
		);
		observed.terminals.push(second.terminal.type);
		checks.ok(
			"next direct prompt was accepted",
			second.acknowledgement.success === true && second.terminal.type === "agent_end",
		);
		observed.goals.reactivated = toolGoal(client.events, "qa-get-reactivated-goal");
		checks.ok(
			"get_goal observed active before the next model action",
			observed.goals.reactivated.status === "active" &&
				observed.goals.reactivated.blockedReason === undefined,
		);
		observed.goals.intentional = readGoal(box.agentDir);
		checks.ok(
			"model-authored update_goal persisted an intentional block",
			observed.goals.intentional.status === "blocked" &&
				observed.goals.intentional.blockedReason === INTENTIONAL_REASON,
		);

		const third = await runPrompt(
			client,
			"Inspect the intentionally blocked goal without explicitly resuming it.",
		);
		observed.terminals.push(third.terminal.type);
		checks.ok(
			"later direct prompt was accepted",
			third.acknowledgement.success === true && third.terminal.type === "agent_end",
		);
		observed.goals.toolPreserved = toolGoal(client.events, "qa-get-still-blocked-goal");
		observed.goals.preserved = readGoal(box.agentDir);
		checks.ok(
			"get_goal observed the intentional block unchanged",
			observed.goals.toolPreserved.status === "blocked" &&
				observed.goals.toolPreserved.blockedReason === INTENTIONAL_REASON &&
				observed.goals.preserved.id === observed.goals.intentional.id &&
				observed.goals.preserved.status === "blocked" &&
				observed.goals.preserved.blockedReason === INTENTIONAL_REASON &&
				Number.isFinite(observed.goals.intentional.blockedAt) &&
				observed.goals.preserved.blockedAt === observed.goals.intentional.blockedAt,
		);

		observed.requestCount = server.requests.length;
		checks.ok("scripted run made exactly seven localhost provider requests", observed.requestCount === 7);
		observed.localhostOnly =
			server.origin.startsWith("http://127.0.0.1:") &&
			server.requests.every(
				(request) => request.method === "POST" && request.url?.endsWith("/chat/completions"),
			);
		checks.ok("zero real provider calls", observed.localhostOnly, server.origin);
	} catch (error) {
		checks.ok("scenario completed without an exception", false, error instanceof Error ? error.message : String(error));
	} finally {
		if (client) {
			client.close();
			try {
				rpcExitCode = await client.waitForExit(5_000);
			} catch {
				client.kill();
				rpcExitCode = await client.waitForExit(5_000).catch(() => null);
			}
			checks.ok("RPC process exited after stdin closed", rpcExitCode === 0, `exitCode=${rpcExitCode}`);
		}
		if (server) await server.stop();
		try {
			realAuthUnchanged = authGuard.assertUnchanged();
		} catch {
			realAuthUnchanged = false;
		}
		checks.ok("real auth unchanged", realAuthUnchanged, authGuard.path);
		box.cleanup();
		checks.ok("isolated sandbox removed", !existsSync(box.dir), box.dir);
	}

	const pass = checks.finish();
	writeJson(join(evidence, "summary.json"), {
		pass,
		terminalEvents: observed.terminals,
		providerRequestCount: observed.requestCount,
		providerErrorStatus: observed.goals.providerError?.status ?? null,
		reactivatedStatus: observed.goals.reactivated?.status ?? null,
		intentionalStatus: observed.goals.preserved?.status ?? null,
		blockedAtUnchanged:
			observed.goals.intentional?.blockedAt === observed.goals.preserved?.blockedAt,
		localhostOnly: observed.localhostOnly,
		realAuthUnchanged,
		rpcExitCode,
		serverStopped: server !== undefined,
		sandboxRemoved: !existsSync(box.dir),
	});
	writeFileSync(
		join(evidence, "rpc-events.jsonl"),
		`${(client?.events ?? []).map((event) => JSON.stringify(event)).join("\n")}\n`,
	);
	for (const [name, goal] of Object.entries(observed.goals)) {
		writeJson(join(evidence, `goal-${name}.json`), goal);
	}
	writeJson(join(evidence, "mock-request-summary.json"), safeRequests(server?.requests ?? []));
	process.stdout.write(`Evidence: ${evidence}\n`);
	process.exitCode = pass ? 0 : 1;
}

await main();
