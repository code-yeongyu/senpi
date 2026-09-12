#!/usr/bin/env node
// senpi-qa driver for the senpi.eval.execution settle event over the RPC channel.
//
// Proves the producer contract end-to-end on a REAL CLI: an RPC session that
// advertises the `extension_events` capability must receive exactly one
// `extension_event` named `senpi.eval.execution` when an eval cell performing
// nested host tool calls settles, with accurate per-tool metadata.
//
// Flow: prompt -> fake model calls eval -> the cell calls two distinct host
// tools (read + bash) through the bridge -> cell settles -> codemode emits
// senpi.eval.execution via pi.rpc.emit -> EventBus -> connection-handler forwards it
// (capability-gated) to this client as {type:"extension_event", name:"senpi.eval.execution"}.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/eval-execution-event-qa.mjs --self-test
//   node .agents/skills/senpi-qa/scripts/scenarios/eval-execution-event-qa.mjs --self-test --evidence eval-execution-event
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox } from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, checkRealAuthUnchanged, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { RpcClient } from "../lib/rpc-client.mjs";

const API = "openai-completions";
const WAIT_TIMEOUT_MS = 120000;
const EVENT_NAME = "senpi.eval.execution";
const COMMAND =
	"node .agents/skills/senpi-qa/scripts/scenarios/eval-execution-event-qa.mjs --self-test --evidence eval-execution-event";

const argv = process.argv.slice(2);
const evidenceIndex = argv.indexOf("--evidence");
const evidenceSlug = evidenceIndex >= 0 ? argv[evidenceIndex + 1] : undefined;

function createRecordedChecks(title) {
	const base = createChecks(title);
	const lines = [];
	let passed = 0;
	let total = 0;
	return {
		ok(name, condition, detail = "") {
			total++;
			if (condition) passed++;
			lines.push(`[${condition ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
			return base.ok(name, condition, detail);
		},
		finish() {
			lines.push("", `${title}: ${passed}/${total} passed`);
			return base.finish();
		},
		stdout() {
			return `${lines.join("\n")}\n`;
		},
	};
}

function waitForChildExit(child, timeoutMs = 10000) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off("close", onClose);
			resolve(exited);
		};
		const onClose = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("close", onClose);
	});
}

async function closeRpcClient(client) {
	if (!client) return true;
	client.close();
	if (await waitForChildExit(client.child)) return true;
	client.child.kill("SIGKILL");
	return await waitForChildExit(client.child);
}

async function selfTest() {
	installCleanupHooks();
	if (evidenceIndex >= 0 && !evidenceSlug) throw new Error("--evidence requires a slug");

	const title = "eval-execution-event-qa.mjs --self-test";
	const checks = createRecordedChecks(title);
	const guard = guardRealAuth();
	const preset = API_PRESETS[API];
	const box = makeSandbox("eval-execution-event");
	const evidence = evidenceSlug === undefined ? undefined : evidenceDir(evidenceSlug);
	writeFileSync(join(box.cwd, "note-a.txt"), "eval-execution-qa\n");

	let server;
	let client;
	let event;
	let runError;
	let cliExited = false;
	let serverStopped = false;
	let authUnchanged = false;

	try {
		server = await startFakeModelServer({
			turns: [
				{
					toolCalls: [
						{
							name: "eval",
							args: {
								language: "js",
								code: 'const a = await tool.read({ path: "note-a.txt" });\nconst b = await tool.bash({ command: "echo eval-execution-qa" });\n"tools-done";',
								summary: "call two distinct host tools, then settle",
							},
						},
					],
				},
				{ text: "EVAL-EVENT-SEEN" },
			],
		});
		writeMockModelsJson(box.agentDir, server, API);
		client = new RpcClient({
			env: {
				...hermeticEnv(box.env),
				// Keep the requested launcher-facing spelling in the receipt environment;
				// the branded CLI resolves the same suffix through its SENPI_ namespace.
				RPC_CLIENT_CAPABILITIES: "extension_events",
				SENPI_RPC_CLIENT_CAPABILITIES: "extension_events",
			},
			cwd: box.cwd,
			extraArgs: ["--provider", preset.provider, "--model", preset.modelId, "--no-extensions", "--approve"],
		});

		await client.send({ type: "get_state" });
		const eventPending = client.waitForEvent(
			(message) => message.type === "extension_event" && message.name === EVENT_NAME,
			{ timeoutMs: WAIT_TIMEOUT_MS },
		);
		const terminalPending = client.waitForEvent(
			(message) => message.type === "agent_end" || message.type === "agent_aborted",
			{ timeoutMs: WAIT_TIMEOUT_MS },
		);
		const ack = await client.send({ type: "prompt", message: "Run the scripted eval cell." });
		checks.ok("RPC accepted the prompt", ack.success === true, JSON.stringify(ack.data ?? {}).slice(0, 120));

		event = await eventPending;
		const terminal = await terminalPending;
		checks.ok("scripted agent turn completed", terminal.type === "agent_end", `terminal=${terminal.type}`);
		checks.ok("fake model observed the eval result", server.requests.length === 2, `requests=${server.requests.length}`);

		const data = event.data ?? {};
		checks.ok("event carries version 1", data.version === 1, `version=${JSON.stringify(data.version)}`);
		checks.ok("RPC event is metadata-only", data.detailLevel === "metadata", `detailLevel=${JSON.stringify(data.detailLevel)}`);
		checks.ok("RPC projection stayed within its byte cap", data.rpcTruncated === false, `rpcTruncated=${JSON.stringify(data.rpcTruncated)}`);
		checks.ok("cellId present", typeof data.cellId === "string" && data.cellId.length > 0, `cellId=${JSON.stringify(data.cellId)}`);
		checks.ok("language reported", data.language === "js", `language=${JSON.stringify(data.language)}`);
		checks.ok("cell settled ok", data.ok === true, `ok=${JSON.stringify(data.ok)}`);
		checks.ok(
			"toolCallCount counts every nested host call",
			data.toolCallCount === 2,
			`toolCallCount=${JSON.stringify(data.toolCallCount)}`,
		);

		const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
		checks.ok("bounded per-call list has both calls", calls.length === 2, `toolCalls.length=${calls.length}`);
		const names = calls.map((call) => call.name).sort();
		checks.ok("toolCalls name bash and read", names.join(",") === "bash,read", `names=${names.join(",")}`);
		checks.ok(
			"each tool call has a nonnegative duration",
			calls.every((call) => typeof call.durationMs === "number" && call.durationMs >= 0),
			`durations=${calls.map((call) => call.durationMs).join(",")}`,
		);
		checks.ok(
			"RPC tool calls exclude prompts, arguments, outputs, errors, and call ids",
			calls.every(
				(call) =>
					!("args" in call) &&
					!("resultPreview" in call) &&
					!("error" in call) &&
					!("callId" in call),
			) && !("error" in data),
			JSON.stringify(calls),
		);

		const distinct = Array.isArray(data.distinctToolsCalled) ? [...data.distinctToolsCalled].sort() : [];
		checks.ok("distinctToolsCalled exact", distinct.join(",") === "bash,read", `distinct=${distinct.join(",")}`);

		const aggregates = data.toolAggregates ?? {};
		const aggregateNames = Object.keys(aggregates).sort();
		const readAggregate = aggregates.read;
		const bashAggregate = aggregates.bash;
		checks.ok(
			"tool aggregates exact with nonnegative totals",
			aggregateNames.join(",") === "bash,read" &&
				readAggregate?.count === 1 &&
				bashAggregate?.count === 1 &&
				typeof readAggregate.totalDurationMs === "number" &&
				readAggregate.totalDurationMs >= 0 &&
				typeof bashAggregate.totalDurationMs === "number" &&
				bashAggregate.totalDurationMs >= 0,
			`read=${JSON.stringify(readAggregate)} bash=${JSON.stringify(bashAggregate)}`,
		);
		checks.ok(
			"wall-clock fields coherent",
			typeof data.startedAt === "number" &&
			typeof data.completedAt === "number" &&
				data.startedAt <= data.completedAt &&
				typeof data.durationMs === "number" &&
				data.durationMs === data.completedAt - data.startedAt &&
				typeof data.kernelDurationMs === "number" &&
				data.kernelDurationMs >= 0,
			`startedAt=${data.startedAt} completedAt=${data.completedAt} durationMs=${data.durationMs} kernelDurationMs=${data.kernelDurationMs}`,
		);
		const matchingEvents = client.events.filter(
			(message) => message.type === "extension_event" && message.name === EVENT_NAME,
		);
		checks.ok("exactly one senpi.eval.execution event", matchingEvents.length === 1, `${matchingEvents.length} events`);
	} catch (error) {
		runError = error;
	} finally {
		cliExited = await closeRpcClient(client);
		if (server) {
			await server.stop().catch(() => {});
			serverStopped = true;
		} else {
			serverStopped = true;
		}
		box.cleanup();
		try {
			authUnchanged = guard.assertUnchanged();
		} catch {}
	}

	checks.ok(
		"scenario completed without runtime error",
		runError === undefined,
		runError === undefined ? "no runtime error" : runError instanceof Error ? runError.message : String(runError),
	);
	checkRealAuthUnchanged(checks, guard);
	const cleanup = {
		cliExited,
		serverStopped,
		sandboxRemoved: !existsSync(box.dir),
		authUnchanged,
	};
	checks.ok("spawned resources were cleaned up", Object.values(cleanup).every(Boolean), JSON.stringify(cleanup));

	if (evidence) {
		writeFileSync(join(evidence, "command.txt"), `${COMMAND}\n`);
		writeFileSync(join(evidence, "rpc-events.jsonl"), `${(client?.events ?? []).map((message) => JSON.stringify(message)).join("\n")}\n`);
		writeFileSync(join(evidence, "eval-execution-event.json"), `${JSON.stringify(event ?? null, null, 2)}\n`);
		writeFileSync(join(evidence, "stderr.txt"), `${client?.stderr ?? ""}${runError ? `${runError instanceof Error ? runError.stack : String(runError)}\n` : ""}`);
		writeFileSync(join(evidence, "cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
	}

	const passed = checks.finish() && !runError;
	if (evidence) {
		writeFileSync(join(evidence, "stdout.txt"), checks.stdout());
		process.stderr.write(`evidence: ${evidence}\n`);
	}
	if (runError) process.stderr.write(`${runError instanceof Error ? runError.stack : String(runError)}\n`);
	process.exit(passed ? 0 : 1);
}

if (argv[0] === "--self-test") {
	selfTest().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exit(1);
	});
} else {
	process.stderr.write(
		[
			"senpi-qa — senpi.eval.execution settle event over the RPC channel",
			"  node scenarios/eval-execution-event-qa.mjs --self-test [--evidence <slug>]",
			"",
		].join("\n"),
	);
	process.exitCode = 2;
}
