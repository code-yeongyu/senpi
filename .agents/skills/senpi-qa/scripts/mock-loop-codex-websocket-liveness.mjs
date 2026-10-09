/**
 * Real-CLI scenario for senpi#1648 (five-minute freezes on gpt-5.6-sol over the
 * Codex WebSocket transport). Runs the coding agent under Bun - the runtime the
 * omo native binary uses and the only one whose WebSocket exposes ping() - in
 * RPC mode against a fake Codex WebSocket backend behind a TCP blackhole proxy.
 *
 * Turn 1 completes and the server closes the parked socket (a server idle
 * close). Turn 2 must open a fresh connection and complete without a
 * stream-start timeout (the base tree reused the closed socket and waited out
 * the watchdog). Turn 3 receives two events and then the proxy blackholes the
 * path, so the client's pings are swallowed: the turn must fail with the
 * liveness verdict in about 70 s, well inside the idle bound, and the automatic
 * retry (proxy passing again) must complete the turn.
 *
 * Usage: bun mock-loop-codex-websocket-liveness.mjs [--evidence-dir <dir>]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
	cliEntry,
	createChecks,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	track,
} from "./lib/common.mjs";
import { CODEX_WS_OK_MARKER, startBlackholeProxy, startCodexWebSocketMock } from "./lib/codex-websocket-mock.mjs";
import { hermeticEnv } from "./lib/mock-loop-support.mjs";
import { RpcQaClient } from "./lib/rpc-qa-client.mjs";

const IDLE_TIMEOUT_MS = 120_000;
const STREAM_START_TIMEOUT_MS = 8_000;
const LIVENESS_PATTERN = /^WebSocket liveness timeout after \d+ms \(\d+ pings unanswered\)$/;
const STREAM_START_PATTERN = /^Provider stream start timed out after \d+ms/;
const IDLE_PATTERN = /^Idle timeout waiting for provider stream after \d+ms$/;

function codexToken() {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_senpi_qa" } }),
		"utf8",
	).toString("base64");
	return `qa.${payload}.sig`;
}

function spawnBunCli(args, { env, cwd }) {
	if (!process.versions.bun) throw new Error("run this scenario with bun: the Codex wrapper under test is Bun-only");
	const child = spawn(process.execPath, [cliEntry(), ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	track(child);
	return child;
}

const isAssistantEnd = (event) => event.type === "message_end" && event.message?.role === "assistant";
const errorOf = (event) => (typeof event.message?.errorMessage === "string" ? event.message.errorMessage : "");

async function runTurn(client, message, { expectError, timeoutMs }) {
	const startIndex = client.events.length;
	const startedAt = Date.now();
	await client.send({ type: "prompt", message });
	const ends = [];
	let cursor = startIndex;
	while (true) {
		const end = await client.waitForEvent(isAssistantEnd, cursor, timeoutMs);
		ends.push({ atMs: Date.now() - startedAt, stopReason: end.message.stopReason, error: errorOf(end) });
		cursor = client.events.indexOf(end) + 1;
		if (end.message.stopReason !== "error") break;
		if (!expectError) break;
	}
	await client.waitForEvent((event) => event.type === "agent_settled", startIndex, timeoutMs);
	const last = await client.send({ type: "get_last_assistant_text" });
	return { ends, durationMs: Date.now() - startedAt, text: typeof last.data?.text === "string" ? last.data.text : "" };
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-codex-websocket-liveness.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("mock-loop-codex-websocket-liveness");
	const evidenceFlagIndex = process.argv.indexOf("--evidence-dir");
	const evidenceFlag = evidenceFlagIndex !== -1 ? process.argv[evidenceFlagIndex + 1] : undefined;
	const evidencePath = evidenceFlag
		? isAbsolute(evidenceFlag)
			? evidenceFlag
			: resolve(repoRoot(), evidenceFlag)
		: join(repoRoot(), "local-ignore", "qa-evidence", "20260913-codex-websocket-liveness");
	mkdirSync(evidencePath, { recursive: true });

	const server = await startCodexWebSocketMock({
		behavior: (index) => (index === 1 ? "complete-then-close" : index === 3 ? "stall-after-start" : "complete"),
	});
	const proxy = await startBlackholeProxy(server.port);
	let client;
	let summary = { pass: false };
	try {
		const baseUrl = `http://127.0.0.1:${proxy.port}/backend-api`;
		writeFileSync(
			join(box.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"openai-codex": {
						baseUrl,
						apiKey: codexToken(),
						api: "openai-codex-responses",
						models: [{ id: "gpt-5.6-sol", contextWindow: 400000, maxTokens: 128000, reasoning: true }],
					},
				},
			}),
		);
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify({
				transport: "auto",
				retry: {
					enabled: true,
					maxRetries: 2,
					baseDelayMs: 1,
					provider: { maxRetries: 0, timeoutMs: IDLE_TIMEOUT_MS, streamStartTimeoutMs: STREAM_START_TIMEOUT_MS },
				},
			}),
		);
		client = new RpcQaClient({
			env: hermeticEnv(box.env),
			cwd: box.cwd,
			extraArgs: ["--provider", "openai-codex", "--model", "gpt-5.6-sol", "--no-extensions"],
			spawnCli: spawnBunCli,
		});
		await client.send({ type: "get_state" }, 60_000);

		const turn1 = await runTurn(client, "turn one", { expectError: false, timeoutMs: 30_000 });
		await server.waitForClose();
		// One RPC round trip lets the agent's event loop consume the close frame
		// that is already in its socket buffer before the next prompt is issued.
		await client.send({ type: "get_state" });
		const turn2 = await runTurn(client, "turn two after the server closed the parked socket", {
			expectError: false,
			timeoutMs: 60_000,
		});

		const turn3Index = client.events.length;
		proxy.blackholeAfterUpstreamChunk("response.output_item.added");
		const turn3Promise = runTurn(client, "turn three goes half-open", {
			expectError: true,
			timeoutMs: IDLE_TIMEOUT_MS + 60_000,
		});
		const livenessEnd = await client.waitForEvent(
			(event) => isAssistantEnd(event) && event.message.stopReason === "error",
			turn3Index,
			IDLE_TIMEOUT_MS + 30_000,
		);
		const turn3 = await turn3Promise;

		const turn1Ok = turn1.ends.length === 1 && turn1.ends[0].stopReason === "stop" && turn1.text.includes(`${CODEX_WS_OK_MARKER}-1`);
		checks.ok("turn 1 completes over the websocket", turn1Ok, JSON.stringify(turn1.ends));
		const turn2Ok =
			turn2.ends.length === 1 &&
			turn2.ends[0].stopReason === "stop" &&
			turn2.durationMs < STREAM_START_TIMEOUT_MS &&
			server.connections() === 2 &&
			!turn2.ends.some((end) => STREAM_START_PATTERN.test(end.error));
		checks.ok(
			"turn 2 opens a fresh connection after the parked socket closed, with no stream-start timeout",
			turn2Ok,
			`durationMs=${turn2.durationMs} connections=${server.connections()} ends=${JSON.stringify(turn2.ends)}`,
		);
		const livenessError = errorOf(livenessEnd);
		const livenessAtMs = turn3.ends[0]?.atMs ?? Number.NaN;
		const turn3Ok =
			LIVENESS_PATTERN.test(livenessError) &&
			proxy.trips() === 1 &&
			livenessAtMs < IDLE_TIMEOUT_MS &&
			!turn3.ends.some((end) => IDLE_PATTERN.test(end.error)) &&
			turn3.ends.at(-1)?.stopReason === "stop" &&
			turn3.text.includes(CODEX_WS_OK_MARKER);
		checks.ok(
			"turn 3 half-open socket is declared dead by liveness inside the idle bound and the retry completes",
			turn3Ok,
			`error=${livenessError} atMs=${livenessAtMs} trips=${proxy.trips()} ends=${JSON.stringify(turn3.ends)}`,
		);
		summary = { pass: turn1Ok && turn2Ok && turn3Ok, turn1, turn2, turn3, ledger: server.ledger, events: client.events };
	} catch (error) {
		summary = { ...summary, error: error instanceof Error ? error.message : String(error), ledger: server.ledger, events: client?.events ?? [] };
		throw error;
	} finally {
		client?.close();
		let exitCode = null;
		if (client) {
			try {
				exitCode = await client.waitForExit();
			} catch {
				client.kill();
				exitCode = await client.waitForExit();
			}
		}
		await proxy.stop();
		await server.stop();
		box.cleanup();
		const sandboxRemoved = !existsSync(box.dir);
		const authUnchanged = guard.assertUnchanged();
		const cleanupPassed = exitCode === 0 && sandboxRemoved && authUnchanged;
		summary = { ...summary, pass: summary.pass && cleanupPassed, cleanup: { exitCode, sandboxRemoved, authUnchanged } };
		const { events = [], ...rest } = summary;
		writeFileSync(join(evidencePath, "rpc-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
		writeFileSync(join(evidencePath, "summary.json"), `${JSON.stringify(rest, null, 2)}\n`);
		checks.ok("cleanup: cli exited 0, sandbox removed, real auth unchanged", cleanupPassed, JSON.stringify(summary.cleanup));
		process.stdout.write(`evidence: ${evidencePath}\n`);
	}
	if (!checks.finish()) process.exit(1);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});
