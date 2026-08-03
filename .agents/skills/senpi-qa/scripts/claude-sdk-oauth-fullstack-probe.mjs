#!/usr/bin/env node
/**
 * Full-stack continuity probe for the claude-sdk-oauth lane.
 *
 * Unlike claude-sdk-oauth-registry-probe.mjs (which drives the registry APIs
 * directly), this probe drives the REAL stack: createAgentSession() ->
 * AgentSession.prompt() -> provider streamSimple -> resident session registry
 * or the flattened <conversation_history> path. SDK query creation is
 * intercepted at overrideSdkBoundary — the single choke point BOTH paths share
 * (session-registry.ts queryFactory for the resident path, stream.ts for the
 * non-resident flatten path) — so every query, its lineage, and every submitted
 * user payload is measured on the real code path.
 *
 * The Claude Code subprocess is real; its Anthropic traffic is pinned to a
 * loopback-only SSE server via ANTHROPIC_BASE_URL, so no credentials and no
 * network egress are involved.
 *
 * Run with:
 *   node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-fullstack-probe.mjs --baseline
 *
 * Modes:
 *   --baseline  always exits 0 — the per-turn table IS the deliverable
 *   (default)   gate mode: VERDICT FAIL exits 1
 * Exit 2 is reserved for probe-infrastructure failures (e.g. loopback down).
 */

import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, track } from "./lib/common.mjs";
import {
	classifyPayload,
	createModelCaptureHandler,
	extractPayloadText,
	formatTurnTable,
	seedProbeAgentDir,
	withTimeout,
} from "./lib/claude-sdk-oauth-fullstack-support.mjs";
import { safeDetail } from "./lib/output-safety.mjs";
import { applyHermeticEnvironment, assertHermeticEnvironment } from "./lib/claude-sdk-oauth-hermetic-env.mjs";

const ROOT = repoRoot();
const INNER_FLAG = "SENPI_CLAUDE_SDK_FULLSTACK_PROBE_INNER";
const BASELINE = process.argv.includes("--baseline");
const MATRIX = process.argv.includes("--matrix");
const TURNS = 6;
const MODEL_ID = "claude-haiku-4-5";

if (process.env[INNER_FLAG] !== "1") {
	const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, ...process.argv.slice(2)], {
		cwd: ROOT,
		env: { ...process.env, [INNER_FLAG]: "1" },
		stdio: "inherit",
	});
	if (child.error) {
		// writeSync: a forced exit after an async pipe write can truncate the line.
		writeSync(2, `probe launcher failed: ${child.error.message}\n`);
		process.exit(2);
	}
	// The outer process must EXIT here: continuing past the launcher would
	// re-execute the entire probe body (sandbox, server, session, verdict).
	process.exit(child.status ?? 2);
}

installCleanupHooks();

// --matrix runs the todo-16 scenario matrix and exits: the loopback server,
// the captured queries, and the per-turn payloads are the matrix's evidence.
if (MATRIX) {
	const { runContinuityMatrix } = await import("./lib/claude-sdk-oauth-matrix.mjs");
	process.exit(await runContinuityMatrix({ gate: !BASELINE }));
}

const authGuard = guardRealAuth();
const box = makeSandbox("claude-sdk-fullstack-probe");
const providerRequests = [];
let server;
let session;
let fatal;
let infrastructureFailure;

const turns = [];
const creations = [];
let currentTurn = null;

try {
	server = track(createServer(createModelCaptureHandler((entry) => providerRequests.push(entry))));
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
		throw new Error("probe server did not bind exclusively to 127.0.0.1");
	}
	const baseUrl = `http://127.0.0.1:${address.port}`;

	seedProbeAgentDir(box.agentDir);
	// Hermetic no-credentials contract: ambient Anthropic/OAuth credential and
	// custom-header channels (inherited from the operator's shell) would
	// otherwise be sent to the loopback capture server. The hermetic helper
	// scrubs every credential channel and pins the loopback surface; the
	// assertion keeps the contract honest if a new channel appears.
	applyHermeticEnvironment(process.env, {
		HOME: box.dir,
		USERPROFILE: box.dir,
		TMPDIR: box.dir,
		SENPI_CODING_AGENT_DIR: box.agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: box.sessionDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_API_KEY: "fullstack-probe-dummy-key",
		CLAUDE_CONFIG_DIR: join(box.dir, "claude-config"),
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_DISABLE_TELEMETRY: "1",
		SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION: "ambient",
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	});
	assertHermeticEnvironment(process.env, baseUrl);

	const sourceRoot = join(ROOT, "packages", "coding-agent", "src");
	// Imported eagerly so BOTH the normal-path finally and the signal-path
	// cleanup shim can close the resident registry entry.
	const { closeSession } = await import(
		pathToFileURL(join(sourceRoot, "core", "extensions", "builtin", "claude-sdk-oauth", "session-registry.ts")).href
	);
	const boundaryModule = await import(
		pathToFileURL(join(sourceRoot, "core", "extensions", "builtin", "claude-sdk-oauth", "sdk-boundary.ts")).href
	);
	const baseQuery = boundaryModule.getSdkBoundary().query;
	boundaryModule.overrideSdkBoundary({
		query: (input) => {
			const options = input.options ?? {};
			// The resident registry always creates its query with an explicit
			// sessionId plus the replay-user-messages extraArg (session-registry.ts);
			// the non-resident flatten branch in stream.ts never does either.
			const resident =
				typeof options.sessionId === "string" &&
				options.extraArgs !== undefined &&
				"replay-user-messages" in options.extraArgs;
			const record = {
				index: creations.length + 1,
				path: resident ? "resident-registry" : "flatten-stream",
				sessionId: options.sessionId ?? null,
				resume: options.resume ?? null,
				forked: options.forkSession === true,
				payloads: [],
			};
			creations.push(record);
			const prompt = input.prompt;
			if (typeof prompt === "string") return baseQuery(input);
			const observed = (async function* () {
				for await (const message of prompt) {
					record.payloads.push(message);
					if (currentTurn) currentTurn.payloads.push({ creation: record.index, path: record.path, message });
					yield message;
				}
			})();
			return baseQuery({ ...input, prompt: observed });
		},
	});

	const { createAgentSession } = await import(pathToFileURL(join(sourceRoot, "index.ts")).href);
	const created = await createAgentSession({
		cwd: box.cwd,
		agentDir: box.agentDir,
		noTools: "all",
		autoTitleSessions: false,
	});
	session = created.session;
	// Register the session with the cleanup harness: an interrupt after the
	// Claude session starts must close the resident registry entry AND dispose
	// the session (reaping both Claude Code subprocesses) — the finally path
	// only runs on normal completion.
	track({
		exitCode: null,
		kill: () => {
			try {
				if (session?.id) closeSession(session.id, "probe_shutdown");
			} catch {}
			session.dispose();
		},
	});
	const model = session.modelRuntime.getModel("claude-sdk-oauth", MODEL_ID);
	if (!model) throw new Error("claude-sdk-oauth provider did not register its models");
	await session.setModel(model);

	for (let index = 1; index <= TURNS; index++) {
		const creationsBefore = creations.length;
		const requestsBefore = providerRequests.length;
		currentTurn = { index, payloads: [] };
		await withTimeout(
			session.prompt(`Turn ${index}: reply with TOKEN_T${index}.`, { sessionTitlePrompt: false }),
			`turn ${index}`,
			120_000,
		);
		const newQueries = creations.slice(creationsBefore);
		// Classify EVERY payload in the turn: the LAST one alone cannot surface a
		// divergence buried mid-turn. A turn is flatten if ANY payload is, then
		// bootstrap if ANY is, else delta.
		const classified = currentTurn.payloads.map((entry) => classifyPayload(entry.message));
		turns.push({
			index,
			queries: newQueries.length,
			// The submitted payload text, for the wire-evidence digest gate.
			payloadText: extractPayloadText(currentTurn.payloads.map((entry) => entry.message)),
			path: currentTurn.payloads.at(-1)?.path ?? newQueries.at(-1)?.path ?? "none",
			lineage: creations.at(-1)?.sessionId ?? "none",
			kind: classified.some((item) => item.kind === "flatten")
				? "flatten"
				: classified.some((item) => item.kind === "bootstrap")
					? "bootstrap"
					: (classified.at(-1)?.kind ?? "none"),
			bytes: classified.reduce((total, item) => total + item.bytes, 0),
			wireRequests: providerRequests.length - requestsBefore,
			wireBytes: providerRequests.slice(requestsBefore).reduce((total, item) => total + item.bytes, 0),
		});
		currentTurn = null;
	}
} catch (error) {
	fatal = error instanceof Error ? error : new Error(String(error));
	// A missing Claude binary is setup failure (REJECTED exit 2), not a
	// behavioral continuity FAIL — keep the two distinguishable in CI.
	infrastructureFailure =
		/loopback|ECONNREFUSED|EADDRINUSE|EACCES|did not bind|claude_binary_not_found|Native CLI binary.*not found|Claude native binary.*not found/i.test(
			fatal.message,
		);
} finally {
	// Close the resident registry entry BEFORE disposing the session: the
	// resident OAuth query owns its own Claude Code subprocess, and disposing
	// the session alone does not guarantee that subprocess is reaped.
	try {
		if (session?.id) closeSession(session.id, "probe_shutdown");
	} catch {}
	try {
		session?.dispose?.();
	} catch {}
	if (server) await new Promise((resolve) => server.close(resolve));
	try {
		authGuard.assertUnchanged();
	} catch (error) {
		// Preserve the original error: an auth-assertion failure in teardown
		// must not overwrite an earlier probe/turn failure (and with it the
		// already-computed infrastructure classification).
		fatal = fatal ?? (error instanceof Error ? error : new Error(String(error)));
	}
	box.cleanup();
}

if (infrastructureFailure) {
	process.stdout.write(`REJECTED signal=loopback_unreachable detail=${safeDetail(fatal.message)}\n`);
	// exitCode, not exit(): a forced exit can truncate piped QA output.
	process.exitCode = 2;
} else {
	process.stdout.write(formatTurnTable(turns));
	// The single-query budget (creations.length === 1) IS the lineage gate:
	// with one SDK query creation there is exactly one lineage by
	// construction, so a separate lineages.size check would be redundant.
	const flattenTurns = turns.filter((turn) => turn.kind === "flatten").length;
	// Gate the ROUTE, not just the payload shape: a bootstrap payload on a
	// non-resident (flatten-stream) query must not masquerade as resident-path.
	const nonResidentTurns = turns.filter((turn) => turn.path !== "resident-registry").length;
	// The resident happy path is delta-only after turn 1 (bootstrap is the
	// legitimate first-payload shape): any later non-delta submission means
	// history was re-synthesized inside a resident session.
	const nonDeltaContinuations = turns.filter((turn) => turn.index !== 1 && turn.kind !== "delta").length;
	// Wire evidence is gated, not just tabled: the classified user payload must
	// actually reach the provider — exactly one loopback request per turn,
	// each carrying at least one message, and each turn's submitted payload
	// text must appear in the corresponding wire request (a dropped or
	// replaced prompt can no longer masquerade as continuity success).
	const wireEvidence =
		providerRequests.length === TURNS &&
		providerRequests.every((request) => request.messages >= 1) &&
		turns.every((turn) => {
			const request = providerRequests[turn.index - 1];
			const slice = (turn.payloadText ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
			return slice.length === 0 || (request?.text ?? "").includes(slice);
		});
	const passed =
		!fatal &&
		turns.length === TURNS &&
		creations.length === 1 &&
		flattenTurns === 0 &&
		nonResidentTurns === 0 &&
		nonDeltaContinuations === 0 &&
		wireEvidence;
	if (fatal) process.stderr.write(`PROBE ERROR: ${safeDetail(fatal.stack ?? fatal.message)}\n`);
	process.stdout.write(
		`VERDICT: ${passed ? "PASS" : "FAIL"} fullstack-baseline queries=${creations.length} flatten_turns=${flattenTurns} non_resident=${nonResidentTurns} non_delta=${nonDeltaContinuations} wire_reqs=${providerRequests.length}\n`,
	);
	// exitCode, not exit(): a forced exit can truncate the table/verdict when
	// stdout is a pipe; assigning lets Node flush the QA output first.
	process.exitCode = BASELINE ? 0 : passed ? 0 : 1;
}
