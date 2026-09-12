#!/usr/bin/env node
/**
 * Hermetic real-surface QA for the cursor-agent exec lifecycle fix (PR #915).
 *
 * Drives the REAL source CLI (`--mode rpc`) in an isolated sandbox against a
 * local plaintext-HTTP/2 fake Cursor backend that implements ONLY
 * `/agent.v1.AgentService/Run`, with the REAL cursor-exec-bridge running the
 * session's tools. Two binary scenarios:
 *
 *  1. read lifecycle — the server withholds turnEnded until it decodes
 *     readResult{id} followed by exactly ONE streamClose{id}; PASS requires
 *     CLI stopReason `stop` and non-empty final text.
 *  2. pending exec heartbeat — a server-requested shellStream exec blocks on
 *     a FIFO gate; PASS requires a decoded execClientControlMessage.heartbeat
 *     {id} (numeric, from ExecServerMessage.id) BEFORE the gate releases the
 *     tool, then a terminal shellResult{id} followed by exactly ONE
 *     streamClose{id}, then stopReason `stop`.
 *
 * No real credentials: the only token is a freshly minted fake written to the
 * sandbox models.json; provider-key env vars are stripped; the real
 * ~/.omo/agent/auth.json is hashed before/after. Evidence is sanitized.
 *
 * POSIX only (mkfifo FIFO gate): darwin/linux.
 *
 * Usage: node cursor-exec-lifecycle-qa.mjs [--evidence SLUG] [--self-test]
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
} from "../lib/common.mjs";
import { PROVIDER_ENV_KEYS } from "../lib/mock-loop-support.mjs";
import { driveRpcTurn, QA_MODEL, QA_PROVIDER, seedCursorProvider } from "./cursor-exec-lifecycle/cli-turn.mjs";
import { playPendingShell, playReadLifecycle } from "./cursor-exec-lifecycle/scenarios.mjs";
import { startRunServer } from "./cursor-exec-lifecycle/run-server.mjs";
import { loadCursorWire } from "./cursor-exec-lifecycle/wire.mjs";

const READ_ID = 101;
const SHELL_ID = 202;

function parseArgs(argv) {
	const options = { evidence: "cursor-exec-lifecycle" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--evidence") {
			const next = argv[++i];
			if (!next) throw new Error("--evidence requires a value");
			options.evidence = next;
		} else if (argv[i] === "--self-test") {
			// The scenario run IS its own regression check.
		} else {
			throw new Error(`Unknown option: ${argv[i]}`);
		}
	}
	return options;
}

const sanitize = (text, secrets) => {
	if (!secrets.length) return String(text);
	return String(text).replace(
		new RegExp(secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"),
		"***",
	);
};

async function runScenario({ name, wire, evidence, secrets, playbook, prompt }) {
	const box = makeSandbox(`cursor-exec-${name}`);
	const token = `qa-cursor-${randomUUID()}`;
	secrets.push(token);
	const server = await startRunServer(wire, { expectedAuthorization: `Bearer ${token}` });
	cleanups.push({ box, server });
	seedCursorProvider(box, { baseUrl: `http://127.0.0.1:${server.port}`, token });
	const setup = await playbook(box, server);
	// `.catch` keeps a failing playbook from surfacing as an unhandled
	// rejection while the CLI driver is still failing first.
	const play = setup.play(server, wire).catch((error) => error);
	const turn = await driveRpcTurn(box, prompt);
	const receipt = await play;
	if (receipt instanceof Error) throw receipt;
	writeFileSync(
		join(evidence, `frames-${name}.jsonl`),
		server.log.entries.map((e) => JSON.stringify(e)).map((l) => sanitize(l, secrets)).join("\n") + "\n",
	);
	writeFileSync(
		join(evidence, `rpc-events-${name}.jsonl`),
		turn.events.map((e) => JSON.stringify(e)).map((l) => sanitize(l, secrets)).join("\n") + "\n",
	);
	return { box, server, token, turn, receipt, setup, headers: server.headersReceipt };
}

async function main(cleanups) {
	const options = parseArgs(process.argv.slice(2)),
		checks = createChecks("cursor-exec-lifecycle-qa");
	const guard = guardRealAuth();
	installCleanupHooks();
	if (process.platform === "win32") throw new Error("This scenario needs a POSIX FIFO gate; run on darwin/linux.");
	const evidence = evidenceDir(options.evidence),
		wire = await loadCursorWire(),
		secrets = [];

	// ---- Scenario 1: read lifecycle ------------------------------------
	const one = await runScenario({
		name: "read",
		wire,
		evidence,
		secrets,
		prompt: "Read the QA target file and summarize it.",
		playbook: async (box, server) => {
			const target = join(box.cwd, "qa-target.txt");
			writeFileSync(target, "SENPI-QA-READ-MARKER-4f2a\nsecond line\n");
			return {
				target,
				play: (srv, w) =>
					playReadLifecycle(srv, w, {
						id: READ_ID,
						path: target,
						toolCallId: "call-read-qa",
						finalText: "The QA target was read and summarized.",
					}),
			};
		},
	});
	const readCloses = one.server.all((e) => e.control === "streamClose" && e.id === READ_ID);
	const readResults = one.server.all((e) => e.message === "readResult" && e.id === READ_ID);
	checks.ok("S1 readResult{id} decoded (numeric id)", readResults.length === 1 && readResults[0].idIsNumeric, `frames=${readResults.length}`);
	checks.ok("S1 exactly one streamClose{id}", readCloses.length === 1, `frames=${readCloses.length}`);
	checks.ok("S1 result precedes close", readResults[0].i < readCloses[0].i, `${readResults[0].i} < ${readCloses[0].i}`);
	checks.ok("S1 readResult is success", readResults[0].result === "success", String(readResults[0].result));
	checks.ok("S1 exactly one Run stream", one.server.runCount === 1, `runCount=${one.server.runCount}`);
	checks.ok("S1 CLI stopReason is stop", one.turn.stopReason === "stop", String(one.turn.stopReason));
	checks.ok("S1 final text non-empty", typeof one.turn.text === "string" && one.turn.text.trim().length > 0, JSON.stringify(one.turn.text).slice(0, 80));

	// ---- Scenario 2: pending exec heartbeat -----------------------------
	const two = await runScenario({
		name: "pending-shell",
		wire,
		evidence,
		secrets,
		prompt: "Run the gated command and report its output.",
		playbook: async (box, server) => {
			const fifo = join(box.cwd, "gate.fifo");
			execFileSync("mkfifo", [fifo]);
			const release = async () => {
				const handle = await fsp.open(fifo, "w");
				await handle.write("go\n");
				await handle.close();
			};
			return {
				fifo,
				play: (srv, w) =>
					playPendingShell(srv, w, {
						id: SHELL_ID,
						command: `read -r line < '${fifo}'; printf 'GATE_RELEASED:%s' "$line"`,
						workingDirectory: box.cwd,
						toolCallId: "call-pending-shell",
						release,
						finalText: "The gated command completed; heartbeat observed while it was pending.",
					}),
			};
		},
	});
	const shellHeartbeats = two.server.all((e) => e.control === "heartbeat" && e.id === SHELL_ID);
	const shellResults = two.server.all((e) => e.message === "shellResult" && e.id === SHELL_ID);
	const shellCloses = two.server.all((e) => e.control === "streamClose" && e.id === SHELL_ID);
	const gateStdout = two.server.all(
		(e) => e.message === "shellStream" && e.id === SHELL_ID && (e.detail ?? "").includes("GATE_RELEASED:go"),
	);
	checks.ok("S2 exec heartbeat{id} decoded", shellHeartbeats.length >= 1, `frames=${shellHeartbeats.length}`);
	checks.ok("S2 heartbeat id numeric and == ExecServerMessage.id", shellHeartbeats.every((h) => h.idIsNumeric && h.id === SHELL_ID));
	checks.ok("S2 heartbeat precedes terminal result", shellHeartbeats[0].i < shellResults[0].i, `${shellHeartbeats[0]?.i} < ${shellResults[0]?.i}`);
	checks.ok("S2 exactly one shellResult{id}", shellResults.length === 1, `frames=${shellResults.length}`);
	checks.ok("S2 exactly one streamClose{id}", shellCloses.length === 1, `frames=${shellCloses.length}`);
	checks.ok("S2 result precedes close", shellResults[0].i < shellCloses[0].i, `${shellResults[0].i} < ${shellCloses[0].i}`);
	checks.ok("S2 CLI stopReason is stop", two.turn.stopReason === "stop", String(two.turn.stopReason));
	checks.ok("S2 final text non-empty", typeof two.turn.text === "string" && two.turn.text.trim().length > 0, JSON.stringify(two.turn.text).slice(0, 80));
	checks.ok(
		"S2 gated tool output crossed the wire after the heartbeat",
		gateStdout.length >= 1 && gateStdout[0].i > two.receipt.heartbeat.i,
		`stdout@${gateStdout[0]?.i} > heartbeat@${two.receipt.heartbeat.i}`,
	);
	const runLevel = two.server.all((e) => e.case === "clientHeartbeat");
	checks.ok("S2 run-level heartbeat distinct from exec heartbeat", runLevel.every((e) => e.control === undefined), `runLevel=${runLevel.length}`);

	// ---- Auth guard ------------------------------------------------------
	const authReceipt = {
		realAuthPath: guard.path,
		realAuthSha256Before: guard.before ? `${guard.before.slice(0, 16)}…` : "absent",
		realAuthUnchanged: guard.assertUnchanged(),
		fakeTokens: [
			{ scenario: "read", used: one.headers.authorizationMatchesExpected },
			{ scenario: "pending-shell", used: two.headers.authorizationMatchesExpected },
		],
		headers: [one.headers, two.headers],
		strippedEnvKeys: PROVIDER_ENV_KEYS.filter((k) => !(k in one.turn.env)),
	};
	checks.ok("real auth unchanged", authReceipt.realAuthUnchanged, guard.path);
	checks.ok("S1 server saw only the seeded fake bearer", one.headers.authorizationMatchesExpected);
	checks.ok("S2 server saw only the seeded fake bearer", two.headers.authorizationMatchesExpected);
	checks.ok("provider-key env vars stripped from CLI env", authReceipt.strippedEnvKeys.length === PROVIDER_ENV_KEYS.length, `${authReceipt.strippedEnvKeys.length}/${PROVIDER_ENV_KEYS.length}`);

	// ---- Cleanup ---------------------------------------------------------
	const receipt = { servers: [], sandboxes: [], fifoRemoved: null, exitCodes: [one.turn.exitCode, two.turn.exitCode] };
	for (const run of cleanups) {
		try {
			await run.server.close();
		} catch {}
	}
	for (const run of cleanups) {
		const refused = await new Promise((resolve) => {
			const socket = net.connect({ port: run.server.port, host: "127.0.0.1" });
			socket.once("error", () => resolve(true));
			socket.once("connect", () => {
				socket.destroy();
				resolve(false);
			});
		});
		receipt.servers.push({ port: run.server.port, closed: refused });
		run.box.cleanup();
		receipt.sandboxes.push({ dir: run.box.dir, removed: !existsSync(run.box.dir) });
	}
	receipt.fifoRemoved = !existsSync(two.setup.fifo);
	writeFileSync(join(evidence, "auth-guard.json"), sanitize(JSON.stringify(authReceipt, null, 2), secrets));
	writeFileSync(join(evidence, "cli-stderr.txt"), sanitize([one, two].map((r) => r.turn.stderrTail).join("\n---\n"), secrets));
	writeFileSync(join(evidence, "cleanup.json"), JSON.stringify(receipt, null, 2));
	writeFileSync(
		join(evidence, "report.json"),
		sanitize(
			JSON.stringify(
				{
					command: `node .agents/skills/senpi-qa/scripts/scenarios/cursor-exec-lifecycle-qa.mjs --evidence ${options.evidence}`,
					provider: `${QA_PROVIDER}/${QA_MODEL}`,
					scenarios: [
						{ name: "read-lifecycle", execId: READ_ID, resultIndex: one.receipt.result.i, closeIndex: one.receipt.close.i, stopReason: one.turn.stopReason, text: one.turn.text },
						{ name: "pending-exec-heartbeat", execId: SHELL_ID, heartbeatIndex: two.receipt.heartbeat.i, heartbeatId: two.receipt.heartbeat.id, resultIndex: two.receipt.result.i, closeIndex: two.receipt.close.i, stopReason: two.turn.stopReason, text: two.turn.text },
					],
				},
				null,
				2,
			),
			secrets,
		),
	);
	checks.ok("servers released their ports", receipt.servers.every((s) => s.closed));
	checks.ok("sandboxes removed", receipt.sandboxes.every((s) => s.removed));
	checks.ok("FIFO gate removed", receipt.fifoRemoved);
	process.stderr.write(`evidence: ${evidence}\n`);
	process.exit(checks.finish() ? 0 : 1);
}

const cleanups = [];

async function runAll() {
	try {
		await main(cleanups);
	} finally {
		// Deterministic teardown even when a scenario fails mid-flight; the
		// success path already closed these and close/cleanup are idempotent.
		for (const run of cleanups.splice(0)) {
			try {
				await run.server.close();
			} catch {}
			run.box.cleanup();
		}
	}
}

await runAll();
