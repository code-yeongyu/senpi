#!/usr/bin/env node
/**
 * Real-CLI QA for the additive RPC fast-mode / model-event surface (work plan todo 11).
 *
 * Drives the REAL JSONL stdio RPC protocol (`senpi --mode rpc --multi-session`) against a
 * hermetic sandbox whose models.json declares Codex-shaped models (`api:
 * "openai-codex-responses"`), so `set_fast_mode` reaches the same `applyFastMode` entry point
 * the `/fast` slash command uses. No provider request is ever made: every command under test
 * (`open_session`, `get_state`, `set_fast_mode`, `get_fast_mode`, `cycle_model`,
 * `set_thinking_level`) is answered without contacting the model, so the declared baseUrl is
 * unreachable on purpose.
 *
 * Sequence (each step's literal response/event line is captured):
 *   1. open_session on a Codex-shaped sandbox model
 *   2. set_fast_mode enabled:true         -> success + persisted tier
 *   3. get_state                          -> fastMode:true, serviceTier:"priority"
 *   4. cycle_model                        -> a model_changed EVENT arrives over stdio
 *   5. set_thinking_level bogus, scope turn -> success:false AND get_state unchanged
 *   6. adversarial: set_fast_mode enabled:"yes" / null -> rejected, state untouched
 *   7. fresh session over the same sandbox -> fast mode read back from settings.json
 *
 * PASS = every assertion below prints [PASS] and the process exits 0.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/rpc-fast-mode-surface-qa.mjs \
 *     [--evidence fast-reasoning-effort] [--out <file>]
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const PROVIDER = "openai-codex";
const BASE_MODEL = "gpt-5.6-sol";
const ALT_MODEL = "gpt-5.5";
const BASE_KEY = `${PROVIDER}/${BASE_MODEL}`;
// Deliberately unroutable: this scenario must never reach a provider.
const UNREACHABLE = "http://127.0.0.1:9/v1";

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

function codexModel(id, thinkingLevelMap) {
	return {
		id,
		api: "openai-codex-responses",
		baseUrl: UNREACHABLE,
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 8_192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

function writeSandboxConfig(agentDir) {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[PROVIDER]: {
						baseUrl: UNREACHABLE,
						apiKey: "sk-codex-qa",
						api: "openai-codex-responses",
						models: [
							codexModel(BASE_MODEL),
							// on/off-only ladder: every graded level is vetoed, leaving off + high.
							codexModel(ALT_MODEL, { minimal: null, low: null, medium: null, xhigh: null, max: null }),
						],
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ favoriteModels: [`${PROVIDER}/${BASE_MODEL}`, `${PROVIDER}/${ALT_MODEL}`] }, null, 2),
	);
}

function readSettings(agentDir) {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

async function main() {
	installCleanupHooks();
	const guard = guardRealAuth();
	const checks = createChecks("RPC fast-mode surface QA");

	const outPath =
		arg("--out") ?? join(evidenceDir(arg("--evidence", "fast-reasoning-effort")), "task-11-manual-qa.txt");
	mkdirSync(dirname(outPath), { recursive: true });
	const transcript = [];
	const record = (label, value) => {
		const line = `${label}: ${JSON.stringify(value)}`;
		transcript.push(line);
		process.stdout.write(`${line}\n`);
	};

	const box = makeSandbox("rpc-fast-mode-qa");
	const env = hermeticEnv(box.env);
	const targetRoot = repoRoot();
	writeSandboxConfig(box.agentDir);
	transcript.push(`# sandbox: ${box.dir}`);
	transcript.push(`# models.json: ${readFileSync(join(box.agentDir, "models.json"), "utf8").replace(/\n/g, " ")}`);

	// --- session 1: the full command/event sequence -------------------------
	const client = new TargetRpcClient({ env, cwd: box.cwd, targetRoot, extraArgs: ["--multi-session"] });

	// 1. open_session on the Codex-shaped model.
	const opened = await client.send({
		type: "open_session",
		cwd: box.cwd,
		provider: PROVIDER,
		modelId: BASE_MODEL,
	});
	record("open_session", opened);
	checks.ok("open_session succeeds on a Codex-shaped model", opened.success === true, opened.error ?? "");
	const sessionId = opened.data?.sessionId;
	checks.ok("open_session returns a routing handle", typeof sessionId === "string", String(sessionId));
	// `serviceTier` is optional and JSON drops undefined, so only `fastMode` is guaranteed
	// present here; the tier is asserted once fast mode is on, below.
	checks.ok(
		"open_session state already carries fastMode",
		opened.data?.state?.fastMode === false,
		`fastMode=${opened.data?.state?.fastMode} serviceTier=${opened.data?.state?.serviceTier ?? "(absent — no tier resolved)"}`,
	);

	const send = (command) => client.send({ ...command, sessionId });

	// 2. set_fast_mode enabled:true
	const enabled = await send({ type: "set_fast_mode", enabled: true });
	record("set_fast_mode(true)", enabled);
	checks.ok("set_fast_mode enabled:true succeeds", enabled.success === true, enabled.error ?? "");
	checks.ok(
		"set_fast_mode reports the recorded tier and memory key",
		enabled.data?.enabled === true &&
			enabled.data?.serviceTier === "priority" &&
			enabled.data?.provider === PROVIDER &&
			enabled.data?.modelId === BASE_MODEL,
		JSON.stringify(enabled.data),
	);
	checks.ok(
		"fast mode persisted to sandbox settings.json",
		readSettings(box.agentDir).modelServiceTiers?.[BASE_KEY] === "priority",
		JSON.stringify(readSettings(box.agentDir).modelServiceTiers ?? null),
	);

	// 3. get_state shows fastMode + serviceTier
	const fastState = await send({ type: "get_state" });
	record("get_state (fast on)", fastState);
	checks.ok(
		'get_state reports fastMode:true + serviceTier:"priority"',
		fastState.data?.fastMode === true && fastState.data?.serviceTier === "priority",
		`fastMode=${fastState.data?.fastMode} serviceTier=${fastState.data?.serviceTier}`,
	);
	const getFast = await send({ type: "get_fast_mode" });
	record("get_fast_mode", getFast);
	checks.ok(
		"get_fast_mode agrees with get_state",
		getFast.data?.enabled === true && getFast.data?.serviceTier === "priority",
		JSON.stringify(getFast.data),
	);

	// 4. cycle_model -> a model_changed event must arrive over stdio.
	//    Subscribe BEFORE sending so the event cannot be missed.
	const modelChanged = client.waitFor(
		(event) => event.message.type === "model_changed" && event.message.sessionId === sessionId,
		30_000,
	);
	const cycled = await send({ type: "cycle_model" });
	record("cycle_model", cycled);
	const changedEvent = await modelChanged;
	record("event model_changed", changedEvent.message);
	checks.ok("cycle_model succeeds", cycled.success === true, cycled.error ?? "");
	checks.ok(
		"model_changed event arrived over stdio with the post-switch level",
		changedEvent.message.model?.id === ALT_MODEL &&
			changedEvent.message.source === "cycle" &&
			typeof changedEvent.message.thinkingLevel === "string",
		JSON.stringify({
			model: changedEvent.message.model?.id,
			thinkingLevel: changedEvent.message.thinkingLevel,
			source: changedEvent.message.source,
		}),
	);
	const afterCycle = await send({ type: "get_state" });
	record("get_state (after cycle)", afterCycle);
	checks.ok(
		"model_changed matches the model get_state reports",
		afterCycle.data?.model?.id === changedEvent.message.model?.id &&
			afterCycle.data?.thinkingLevel === changedEvent.message.thinkingLevel,
		`state=${afterCycle.data?.model?.id}/${afterCycle.data?.thinkingLevel}`,
	);

	// 5. scope:"turn" set_thinking_level with a bogus level -> failure, state unchanged.
	const levelsResponse = await send({ type: "get_available_thinking_levels" });
	record("get_available_thinking_levels", levelsResponse);
	const beforeLevel = afterCycle.data?.thinkingLevel;
	const bogus = await send({ type: "set_thinking_level", level: "ultra", scope: "turn" });
	record('set_thinking_level(level:"ultra", scope:"turn")', bogus);
	checks.ok("bogus turn-scoped level is rejected", bogus.success === false, bogus.error ?? "(no error field)");
	const afterBogus = await send({ type: "get_state" });
	record("get_state (after rejected level)", afterBogus);
	checks.ok(
		"rejected turn-scoped level left get_state unchanged",
		afterBogus.data?.thinkingLevel === beforeLevel,
		`${beforeLevel} -> ${afterBogus.data?.thinkingLevel}`,
	);

	// 5b. An unsupported-but-real level on this on/off-only model: same contract.
	const unsupported = await send({ type: "set_thinking_level", level: "low", scope: "turn" });
	record('set_thinking_level(level:"low", scope:"turn")', unsupported);
	const afterUnsupported = await send({ type: "get_state" });
	record("get_state (after unsupported level)", afterUnsupported);
	checks.ok(
		"unsupported turn-scoped level is rejected without clamping the session",
		unsupported.success === false && afterUnsupported.data?.thinkingLevel === beforeLevel,
		`success=${unsupported.success} level=${afterUnsupported.data?.thinkingLevel}`,
	);

	// 6. Adversarial: malformed set_fast_mode payloads.
	const stringly = await send({ type: "set_fast_mode", enabled: "yes" });
	record('set_fast_mode(enabled:"yes")', stringly);
	const nulled = await send({ type: "set_fast_mode", enabled: null });
	record("set_fast_mode(enabled:null)", nulled);
	const afterMalformed = await send({ type: "get_fast_mode" });
	record("get_fast_mode (after malformed)", afterMalformed);
	checks.ok(
		"malformed set_fast_mode payloads are rejected",
		stringly.success === false && nulled.success === false,
		`${stringly.error} | ${nulled.error}`,
	);
	checks.ok(
		"malformed payloads left the persisted tier untouched",
		readSettings(box.agentDir).modelServiceTiers?.[BASE_KEY] === "priority",
		JSON.stringify(readSettings(box.agentDir).modelServiceTiers ?? null),
	);

	await client.close();

	// --- session 2: persistence across a real process restart ---------------
	const restarted = new TargetRpcClient({ env, cwd: box.cwd, targetRoot, extraArgs: ["--multi-session"] });
	const reopened = await restarted.send({
		type: "open_session",
		cwd: box.cwd,
		provider: PROVIDER,
		modelId: BASE_MODEL,
	});
	record("open_session (restarted process)", reopened);
	const restartedFast = await restarted.send({ type: "get_fast_mode", sessionId: reopened.data?.sessionId });
	record("get_fast_mode (restarted process)", restartedFast);
	checks.ok(
		"fast mode survives a full process restart",
		restartedFast.data?.enabled === true && restartedFast.data?.serviceTier === "priority",
		JSON.stringify(restartedFast.data),
	);
	// open_session projects the SAME state shape as get_state: with fast mode remembered, its
	// initial state must already report the tier rather than lagging until the first get_state.
	checks.ok(
		"open_session state matches get_state for the new fields",
		reopened.data?.state?.fastMode === true && reopened.data?.state?.serviceTier === "priority",
		`fastMode=${reopened.data?.state?.fastMode} serviceTier=${reopened.data?.state?.serviceTier}`,
	);
	await restarted.close();

	checks.ok("real credentials untouched", guard.assertUnchanged(), guard.path);

	const passed = checks.finish();
	transcript.push("", `RESULT: ${passed ? "PASS" : "FAIL"}`);
	appendFileSync(outPath, `${transcript.join("\n")}\n`);
	process.stdout.write(`\ntranscript: ${outPath}\n`);
	process.exit(passed ? 0 : 1);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
