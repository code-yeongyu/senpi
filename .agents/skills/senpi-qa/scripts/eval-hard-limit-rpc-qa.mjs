#!/usr/bin/env node
// senpi-qa driver for the eval hard limit on the DETACHED path.
//
// `--print` cannot prove this path: EvalNotifier suppresses injected notices in
// print/json modes, and eval defaults to "error" timeout semantics there. RPC mode
// (`mode: "rpc"`) is interactive as far as both are concerned, so it is the cheapest
// real surface where a cell can detach AND its kill notice can reach the agent.
//
// Flow: model calls eval -> the cell outlives cellTimeoutSeconds and DETACHES ->
// the wall-clock hard limit kills it -> the notice is injected as a user message ->
// the agent starts a new turn, so the fake model's NEXT request body carries the
// <system-reminder> naming the cell and the hard limit. That request body is the proof.
//
//   node .agents/skills/senpi-qa/scripts/eval-hard-limit-rpc-qa.mjs --self-test
//   node .agents/skills/senpi-qa/scripts/eval-hard-limit-rpc-qa.mjs --self-test --evidence eval-hard-limit-rpc
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { API_PRESETS, checkRealAuthUnchanged, hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";
import { RpcClient } from "./lib/rpc-client.mjs";

const API = "openai-completions";
const CELL_TIMEOUT_SECONDS = 2;
const HARD_LIMIT_SECONDS = 5;
const KILL_PHRASE = `${HARD_LIMIT_SECONDS}s hard limit`;
const WAIT_TIMEOUT_MS = 120000;

const argv = process.argv.slice(2);
const evidenceSlug = argv.includes("--evidence") ? argv[argv.indexOf("--evidence") + 1] : undefined;

function bodyOf(request) {
	return request.raw ?? JSON.stringify(request.body ?? {});
}

/** The notice must arrive as an injected user message, not merely somewhere in the payload. */
function carriesKillNotice(request) {
	const messages = request.body?.messages;
	if (!Array.isArray(messages)) return false;
	return messages.some((message) => {
		if (message.role !== "user") return false;
		const parts = Array.isArray(message.content)
			? message.content.map((part) => (typeof part?.text === "string" ? part.text : ""))
			: [typeof message.content === "string" ? message.content : ""];
		return parts.some((text) => text.includes(KILL_PHRASE) && text.includes("Detached eval cell"));
	});
}

/** Bounded wait on an observable condition; never a blind sleep. */
async function waitFor(predicate, { timeoutMs = WAIT_TIMEOUT_MS, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function selfTest() {
	installCleanupHooks();
	const checks = createChecks("eval-hard-limit-rpc-qa.mjs --self-test");
	const guard = guardRealAuth();
	const preset = API_PRESETS[API];
	const box = makeSandbox("eval-hard-limit-rpc");
	// Only the hard limit may end this cell: the detach window is short, the deadline is longer.
	mkdirSync(join(box.cwd, ".senpi"), { recursive: true });
	writeFileSync(
		join(box.cwd, ".senpi", "codemode.json"),
		JSON.stringify({ cellTimeoutSeconds: CELL_TIMEOUT_SECONDS, hardLimitSeconds: HARD_LIMIT_SECONDS }, null, 2),
	);
	const server = await startFakeModelServer({
		turns: [
			{
				toolCalls: [
					{
						name: "eval",
						args: {
							language: "js",
							code: "await new Promise(() => {});",
							summary: "detach, then outlive the hard limit",
							on_timeout: "detach",
						},
					},
				],
			},
			{ text: "DETACH-ACK" },
			{ text: "KILL-NOTICE-SEEN" },
		],
	});
	writeMockModelsJson(box.agentDir, server, API);
	const client = new RpcClient({
		env: hermeticEnv(box.env),
		cwd: box.cwd,
		extraArgs: ["--provider", preset.provider, "--model", preset.modelId, "--no-extensions", "--approve"],
	});
	try {
		await client.send({ type: "get_state" });
		const ack = await client.send({ type: "prompt", message: "Run the scripted eval cell." });
		checks.ok("RPC accepted the prompt", ack.success === true, JSON.stringify(ack.data ?? {}).slice(0, 120));

		await waitFor(() => server.requests.length >= 2, { label: "the detached cell to return control to the model" });
		checks.ok(
			"cell detached instead of blocking the turn",
			server.requests.length >= 2,
			`requests=${server.requests.length}`,
		);

		const hit = await waitFor(
			() => {
				const index = server.requests.findIndex((request, i) => i >= 1 && carriesKillNotice(request));
				return index >= 0 ? { index } : undefined;
			},
			{ label: `the "${KILL_PHRASE}" notice to reach the model` },
		);
		checks.ok(
			"hard-limit kill notice reached the model as an injected user message",
			hit.index >= 1,
			`hitAt=request[${hit.index}] of ${server.requests.length}`,
		);
		checks.ok(
			"notice names the cell and the configured deadline",
			bodyOf(server.requests[hit.index]).includes(KILL_PHRASE),
			KILL_PHRASE,
		);

		if (evidenceSlug !== undefined) {
			const dir = evidenceDir(evidenceSlug);
			writeFileSync(
				join(dir, "rpc-request-bodies.json"),
				JSON.stringify(
					{
						hitAt: hit.index,
						cellTimeoutSeconds: CELL_TIMEOUT_SECONDS,
						hardLimitSeconds: HARD_LIMIT_SECONDS,
						requests: server.requests.map((request, index) => ({ index, url: request.url, raw: bodyOf(request) })),
					},
					null,
					2,
				),
			);
			writeFileSync(join(dir, "rpc-events.jsonl"), client.events.map((event) => JSON.stringify(event)).join("\n"));
			process.stderr.write(`evidence: ${dir}\n`);
		}
	} finally {
		client.close();
		await server.stop();
		checkRealAuthUnchanged(checks, guard);
		box.cleanup();
	}
	process.exit(checks.finish() ? 0 : 1);
}

if (argv[0] === "--self-test") {
	selfTest().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exit(1);
	});
} else {
	process.stderr.write(
		[
			"senpi-qa — eval hard limit on the detached path (RPC channel)",
			"  node eval-hard-limit-rpc-qa.mjs --self-test [--evidence <slug>]",
			"",
		].join("\n"),
	);
	process.exitCode = 2;
}
