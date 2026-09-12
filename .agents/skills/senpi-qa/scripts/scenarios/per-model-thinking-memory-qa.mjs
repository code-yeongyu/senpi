#!/usr/bin/env node
/**
 * Real-CLI QA for per-model thinking memory, /fast persistence, and capability-aware reasoning
 * command errors (work plan todo 13 — the user's literal complaints, on the real surface).
 *
 * Drives the REAL JSONL stdio RPC protocol (`senpi --mode rpc --multi-session`) from source
 * against a hermetic sandbox. The sandbox models.json declares two Codex-shaped models
 * (`api: "openai-codex-responses"`, unroutable baseUrl):
 *
 *   - `qa-graded-a`  full ladder incl. xhigh  (thinkingLevelMap keeps every tier)
 *   - `qa-onoff-b`   on/off only              (every graded tier vetoed -> [off, high])
 *
 * ZERO tokens are spent: every command exercised here (`open_session`, `get_state`,
 * `set_thinking_level`, `cycle_model`, `set_fast_mode`, `get_fast_mode`, `close_session`, and a
 * `/efforts` slash-command prompt, which the session dispatches to the extension runner BEFORE
 * any provider request) is answered without contacting a model. The declared baseUrl points at a
 * closed port on purpose — a run that tried to reach a provider would fail loudly.
 *
 * Assertions (each prints [PASS]/[FAIL]; rc=0 only when all pass):
 *   1. PER-MODEL RESTORE ACROSS 2+ CYCLES — set A to xhigh, ctrl+p to B (clamped), ctrl+p back
 *      to A (xhigh restored); the FULL cycle repeated a second time still lands on xhigh. Both
 *      models' memories are asserted in the sandbox settings.json. A decorated favorite
 *      (`provider/id:high`) is separately confirmed to outrank memory (documented precedence).
 *   2. /fast RESTART PERSISTENCE — set_fast_mode true on the Codex-shaped model, close_session,
 *      open a NEW session over the SAME sandbox: get_fast_mode reports enabled and
 *      `modelServiceTiers` in settings.json reads "priority".
 *   3. CAPABILITY ERROR SURFACING — prompt "/efforts high" on the on/off-only model surfaces the
 *      exact pinned copy through the RPC notify bridge (extension_ui_request, method "notify").
 *   4. PERSISTENCE ACROSS PROCESS RESTART — the CLI process is killed and relaunched:
 *      `modelThinkingLevels` survived on disk and the fresh session picks A up at xhigh.
 *   5. REAL-SURFACE RED CONTROL — the same cycle driven through the memory-FREE path
 *      (`set_thinking_level` with scope:"turn", which by contract never writes memory) loses the
 *      level exactly as the pre-fix build did, on a separate hermetic sandbox. See RED_NOTE.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/per-model-thinking-memory-qa.mjs \
 *     [--evidence fast-reasoning-effort] [--out <file>] [--self-test]
 *
 * `evidenceDir()` already date-prefixes, so the default lands in
 * `local-ignore/qa-evidence/<YYYYMMDD>-fast-reasoning-effort/task-13-scenario.txt`.
 *
 * `--self-test` is accepted as an alias of the default run (the scenario IS its own assertion
 * suite), matching the senpi-qa convention.
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
const GRADED = "qa-graded-a";
const ONOFF = "qa-onoff-b";
const GRADED_KEY = `${PROVIDER}/${GRADED}`;
const ONOFF_KEY = `${PROVIDER}/${ONOFF}`;
// Deliberately unroutable: this scenario must never reach a provider.
const UNREACHABLE = "http://127.0.0.1:9/v1";
/** Seed for never-seen models; also the value the RED control falls back to (must not be xhigh). */
const SEED_LEVEL = "low";
/** Pinned copy from the /efforts handler (packages/coding-agent/.../builtin/reasoning/index.ts). */
const ONOFF_ERROR = `Reasoning effort is not configurable for ${ONOFF_KEY}; this model supports on/off only. Use /reasoning on or /reasoning off.`;

const RED_NOTE = [
	"REAL-SURFACE RED (assertion 5) — why this shape:",
	"  The plan asks for a run against the pre-fix build. This scenario may not mutate git",
	"  (no checkout/stash) and may not build, and the repo ships no pre-T5 dist to launch, so the",
	"  pre-fix code path is reached instead through the ONE surface that still behaves like it:",
	"  `set_thinking_level` with scope:\"turn\" routes to setSessionThinkingLevel, which by contract",
	"  writes NO per-model memory (agent-session.ts _setThinkingLevel, updateGlobalDefault=false).",
	"  A cycle driven that way therefore resolves the returning model from defaultThinkingLevel —",
	"  exactly the global-scalar resolution the pre-fix _getThinkingLevelForModelSwitch always used,",
	"  and exactly the lost-level symptom the user reported. The definitive unit-level RED against",
	"  genuinely unpatched code is task-5-red.txt in the same evidence dir.",
].join("\n");

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

/**
 * @param {string} agentDir
 * @param {string[]} favoriteModels favorite patterns, verbatim (decorators intentional)
 */
function writeSandboxConfig(agentDir, favoriteModels) {
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
							// Full ladder: an explicit xhigh entry makes supportsXhigh() true without id inference.
							codexModel(GRADED, {
								minimal: "minimal",
								low: "low",
								medium: "medium",
								high: "high",
								xhigh: "xhigh",
							}),
							// on/off-only ladder: every graded tier is vetoed, leaving off + high.
							codexModel(ONOFF, { minimal: null, low: null, medium: null, xhigh: null, max: null }),
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
		JSON.stringify({ favoriteModels, defaultThinkingLevel: SEED_LEVEL }, null, 2),
	);
}

function readSettings(agentDir) {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

function openClient(box, env) {
	return new TargetRpcClient({ env, cwd: box.cwd, targetRoot: repoRoot(), extraArgs: ["--multi-session"] });
}

async function main() {
	installCleanupHooks();
	const guard = guardRealAuth();
	const rawChecks = createChecks("per-model thinking memory QA");

	const outPath =
		arg("--out") ?? join(evidenceDir(arg("--evidence", "fast-reasoning-effort")), "task-13-scenario.txt");
	mkdirSync(dirname(outPath), { recursive: true });
	const transcript = [];
	const record = (label, value) => {
		const line = `${label}: ${JSON.stringify(value)}`;
		transcript.push(line);
		process.stdout.write(`${line}\n`);
	};
	const note = (line) => {
		transcript.push(line);
		process.stdout.write(`${line}\n`);
	};
	// Mirror every assertion into the transcript: the artifact IS the evidence, so a reader must
	// see the [PASS]/[FAIL] lines without re-running the scenario.
	const checks = {
		ok(name, cond, detail = "") {
			const result = rawChecks.ok(name, cond, detail);
			transcript.push(`[${result ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
			return result;
		},
		finish: () => rawChecks.finish(),
	};

	const box = makeSandbox("per-model-thinking-qa");
	const env = hermeticEnv(box.env);
	writeSandboxConfig(box.agentDir, [GRADED_KEY, ONOFF_KEY]);
	note(`# sandbox: ${box.dir}`);
	note(`# favorites: ${JSON.stringify([GRADED_KEY, ONOFF_KEY])} defaultThinkingLevel=${SEED_LEVEL}`);

	const clients = [];
	try {
		// =====================================================================
		// Assertion 1 — per-model restore across 2+ full cycles
		// =====================================================================
		note("\n=== assertion 1: per-model restore across repeated cycles ===");
		const client = openClient(box, env);
		clients.push(client);
		const opened = await client.send({
			type: "open_session",
			cwd: box.cwd,
			provider: PROVIDER,
			modelId: GRADED,
		});
		record("open_session(A)", opened);
		checks.ok("open_session succeeds on the graded model", opened.success === true, opened.error ?? "");
		const sessionId = opened.data?.sessionId;
		const send = (command) => client.send({ ...command, sessionId });

		const levels = await send({ type: "get_available_thinking_levels" });
		record("get_available_thinking_levels(A)", levels);
		checks.ok(
			"graded model A exposes the xhigh ladder",
			Array.isArray(levels.data?.levels) && levels.data.levels.includes("xhigh"),
			JSON.stringify(levels.data?.levels),
		);

		const setXhigh = await send({ type: "set_thinking_level", level: "xhigh" });
		record("set_thinking_level(A, xhigh)", setXhigh);
		checks.ok("set_thinking_level xhigh on A succeeds", setXhigh.success === true, setXhigh.error ?? "");

		/** One ctrl+p: cycle and report the post-switch state (event-driven, no polling). */
		const cycle = async (label) => {
			const changed = client.waitFor(
				(event) => event.message.type === "model_changed" && event.message.sessionId === sessionId,
				30_000,
			);
			const response = await send({ type: "cycle_model" });
			const event = await changed;
			const state = await send({ type: "get_state" });
			record(`cycle_model ${label}`, {
				ok: response.success,
				event: { model: event.message.model?.id, thinkingLevel: event.message.thinkingLevel },
				state: { model: state.data?.model?.id, thinkingLevel: state.data?.thinkingLevel },
			});
			return { model: state.data?.model?.id, level: state.data?.thinkingLevel, event: event.message };
		};

		const cycle1 = await cycle("#1 (A -> B)");
		checks.ok(
			"cycle #1 lands on the on/off model at its clamped level",
			cycle1.model === ONOFF && cycle1.level === "high",
			`${cycle1.model}/${cycle1.level}`,
		);
		const cycle2 = await cycle("#2 (B -> A)");
		checks.ok(
			"cycle #2 restores model A at xhigh (the reported bug)",
			cycle2.model === GRADED && cycle2.level === "xhigh",
			`${cycle2.model}/${cycle2.level}`,
		);
		// Second FULL cycle: memory must not be a one-shot.
		const cycle3 = await cycle("#3 (A -> B)");
		checks.ok(
			"cycle #3 lands on B again at its clamped level",
			cycle3.model === ONOFF && cycle3.level === "high",
			`${cycle3.model}/${cycle3.level}`,
		);
		const cycle4 = await cycle("#4 (B -> A)");
		checks.ok(
			"cycle #4 STILL restores model A at xhigh (second full cycle)",
			cycle4.model === GRADED && cycle4.level === "xhigh",
			`${cycle4.model}/${cycle4.level}`,
		);

		// The returning model's level must come from ITS key, so a manual level on B must persist too.
		const setOff = await send({ type: "set_thinking_level", level: "xhigh" });
		record("set_thinking_level(A, xhigh — re-persist)", setOff);
		const cycle5 = await cycle("#5 (A -> B)");
		const setBHigh = await send({ type: "set_thinking_level", level: "off" });
		record("set_thinking_level(B, off)", setBHigh);
		const cycle6 = await cycle("#6 (B -> A)");
		checks.ok(
			"a manual level on B does not disturb A's memory",
			cycle5.model === ONOFF && cycle6.model === GRADED && cycle6.level === "xhigh",
			`B=${cycle5.level} -> A=${cycle6.level}`,
		);
		const cycle7 = await cycle("#7 (A -> B)");
		checks.ok(
			"B returns at its OWN remembered level (off)",
			cycle7.model === ONOFF && cycle7.level === "off",
			`${cycle7.model}/${cycle7.level}`,
		);

		const memory = readSettings(box.agentDir).modelThinkingLevels ?? null;
		record("settings.modelThinkingLevels", memory);
		checks.ok(
			"both models' levels are remembered in sandbox settings.json",
			memory?.[GRADED_KEY] === "xhigh" && memory?.[ONOFF_KEY] === "off",
			JSON.stringify(memory),
		);

		// =====================================================================
		// Assertion 3 — capability error copy over the RPC notify bridge
		// (driven here: the session is already parked on the on/off model)
		// =====================================================================
		note("\n=== assertion 3: /efforts capability error surfacing ===");
		const notified = client.waitFor(
			(event) =>
				event.message.type === "extension_ui_request" &&
				event.message.method === "notify" &&
				event.message.sessionId === sessionId,
			30_000,
		);
		const effortsPrompt = await send({ type: "prompt", message: "/efforts high" });
		record("prompt(/efforts high on B)", effortsPrompt);
		const notifyEvent = await notified;
		record("event notify", notifyEvent.message);
		checks.ok(
			"the on/off-only /efforts error copy surfaces verbatim over the notify bridge",
			notifyEvent.message.message === ONOFF_ERROR && notifyEvent.message.notifyType === "error",
			JSON.stringify({ message: notifyEvent.message.message, notifyType: notifyEvent.message.notifyType }),
		);
		const afterEfforts = await send({ type: "get_state" });
		record("get_state (after rejected /efforts)", afterEfforts);
		checks.ok(
			"the rejected /efforts left B's level untouched",
			afterEfforts.data?.model?.id === ONOFF && afterEfforts.data?.thinkingLevel === "off",
			`${afterEfforts.data?.model?.id}/${afterEfforts.data?.thinkingLevel}`,
		);

		// =====================================================================
		// Assertion 2 — /fast persists across close_session + a NEW session
		// =====================================================================
		note("\n=== assertion 2: /fast persistence across sessions ===");
		const backToA = await cycle("#8 (B -> A, back to the codex-shaped model)");
		checks.ok("back on model A for the fast-mode step", backToA.model === GRADED, String(backToA.model));

		const fastOn = await send({ type: "set_fast_mode", enabled: true });
		record("set_fast_mode(true)", fastOn);
		checks.ok(
			"set_fast_mode enabled:true records the priority tier",
			fastOn.success === true && fastOn.data?.enabled === true && fastOn.data?.serviceTier === "priority",
			JSON.stringify(fastOn.data ?? fastOn.error),
		);

		const closed = await client.send({ type: "close_session", sessionId });
		record("close_session", closed);
		checks.ok("close_session succeeds", closed.success === true, closed.error ?? "");

		const reopened = await client.send({
			type: "open_session",
			cwd: box.cwd,
			provider: PROVIDER,
			modelId: GRADED,
		});
		record("open_session (new session, same sandbox)", reopened);
		const newSessionId = reopened.data?.sessionId;
		const fastRead = await client.send({ type: "get_fast_mode", sessionId: newSessionId });
		record("get_fast_mode (new session)", fastRead);
		checks.ok(
			"a NEW session over the same sandbox reports fast mode enabled",
			fastRead.data?.enabled === true && fastRead.data?.serviceTier === "priority",
			JSON.stringify(fastRead.data),
		);
		const tiers = readSettings(box.agentDir).modelServiceTiers ?? null;
		record("settings.modelServiceTiers", tiers);
		checks.ok(
			'sandbox settings.json modelServiceTiers reads "priority"',
			tiers?.[GRADED_KEY] === "priority",
			JSON.stringify(tiers),
		);
		// The new session must also carry A's remembered level from startup resolution.
		const newState = await client.send({ type: "get_state", sessionId: newSessionId });
		record("get_state (new session)", newState);
		checks.ok(
			"the new session starts model A at its remembered xhigh",
			newState.data?.model?.id === GRADED && newState.data?.thinkingLevel === "xhigh",
			`${newState.data?.model?.id}/${newState.data?.thinkingLevel}`,
		);

		await client.close();

		// =====================================================================
		// Assertion 4 — survival across a full CLI process restart
		// =====================================================================
		note("\n=== assertion 4: persistence across a process restart ===");
		const onDisk = readSettings(box.agentDir);
		record("settings.json after process exit", {
			modelThinkingLevels: onDisk.modelThinkingLevels ?? null,
			modelServiceTiers: onDisk.modelServiceTiers ?? null,
			favoriteModels: onDisk.favoriteModels ?? null,
		});
		checks.ok(
			"modelThinkingLevels survived the process exit on disk",
			onDisk.modelThinkingLevels?.[GRADED_KEY] === "xhigh" && onDisk.modelThinkingLevels?.[ONOFF_KEY] === "off",
			JSON.stringify(onDisk.modelThinkingLevels ?? null),
		);
		checks.ok(
			"favorite patterns round-tripped unchanged",
			JSON.stringify(onDisk.favoriteModels) === JSON.stringify([GRADED_KEY, ONOFF_KEY]),
			JSON.stringify(onDisk.favoriteModels ?? null),
		);

		const restarted = openClient(box, env);
		clients.push(restarted);
		const restartOpen = await restarted.send({
			type: "open_session",
			cwd: box.cwd,
			provider: PROVIDER,
			modelId: GRADED,
		});
		record("open_session (restarted process)", restartOpen);
		const restartSession = restartOpen.data?.sessionId;
		const restartState = await restarted.send({ type: "get_state", sessionId: restartSession });
		record("get_state (restarted process)", restartState);
		checks.ok(
			"a relaunched CLI picks model A back up at xhigh",
			restartState.data?.model?.id === GRADED && restartState.data?.thinkingLevel === "xhigh",
			`${restartState.data?.model?.id}/${restartState.data?.thinkingLevel}`,
		);
		// And cycling in the fresh process still restores per model.
		const restartCycled = restarted.waitFor(
			(event) => event.message.type === "model_changed" && event.message.sessionId === restartSession,
			30_000,
		);
		await restarted.send({ type: "cycle_model", sessionId: restartSession });
		const restartEvent = await restartCycled;
		record("cycle_model (restarted process)", {
			model: restartEvent.message.model?.id,
			thinkingLevel: restartEvent.message.thinkingLevel,
		});
		checks.ok(
			"cycling in the relaunched process restores B's remembered off",
			restartEvent.message.model?.id === ONOFF && restartEvent.message.thinkingLevel === "off",
			`${restartEvent.message.model?.id}/${restartEvent.message.thinkingLevel}`,
		);
		await restarted.close();

		// =====================================================================
		// Assertion 1b — a decorated favorite pin outranks memory (precedence)
		// =====================================================================
		note("\n=== assertion 1b: favorite `:high` decorator outranks per-model memory ===");
		const pinBox = makeSandbox("per-model-thinking-pin");
		const pinEnv = hermeticEnv(pinBox.env);
		writeSandboxConfig(pinBox.agentDir, [`${GRADED_KEY}:high`, ONOFF_KEY]);
		const pinClient = openClient(pinBox, pinEnv);
		clients.push(pinClient);
		const pinOpen = await pinClient.send({
			type: "open_session",
			cwd: pinBox.cwd,
			provider: PROVIDER,
			modelId: GRADED,
		});
		const pinSession = pinOpen.data?.sessionId;
		await pinClient.send({ type: "set_thinking_level", level: "xhigh", sessionId: pinSession });
		const pinCycleAway = pinClient.waitFor(
			(event) => event.message.type === "model_changed" && event.message.sessionId === pinSession,
			30_000,
		);
		await pinClient.send({ type: "cycle_model", sessionId: pinSession });
		await pinCycleAway;
		const pinCycleBack = pinClient.waitFor(
			(event) => event.message.type === "model_changed" && event.message.sessionId === pinSession,
			30_000,
		);
		await pinClient.send({ type: "cycle_model", sessionId: pinSession });
		const pinEvent = await pinCycleBack;
		const pinState = await pinClient.send({ type: "get_state", sessionId: pinSession });
		record("pinned favorite cycle back to A", {
			event: { model: pinEvent.message.model?.id, thinkingLevel: pinEvent.message.thinkingLevel },
			state: { model: pinState.data?.model?.id, thinkingLevel: pinState.data?.thinkingLevel },
			memory: readSettings(pinBox.agentDir).modelThinkingLevels ?? null,
		});
		checks.ok(
			"an explicit favorite `:high` pin wins over the remembered xhigh (documented precedence)",
			pinState.data?.model?.id === GRADED && pinState.data?.thinkingLevel === "high",
			`${pinState.data?.model?.id}/${pinState.data?.thinkingLevel}`,
		);
		checks.ok(
			"the pinned run still remembered the manual xhigh for A",
			readSettings(pinBox.agentDir).modelThinkingLevels?.[GRADED_KEY] === "xhigh",
			JSON.stringify(readSettings(pinBox.agentDir).modelThinkingLevels ?? null),
		);
		await pinClient.close();
		pinBox.cleanup();

		// =====================================================================
		// Assertion 5 — real-surface RED control (memory-free path)
		// =====================================================================
		note("\n=== assertion 5: real-surface RED control (memory-free path) ===");
		note(RED_NOTE);
		const redBox = makeSandbox("per-model-thinking-red");
		const redEnv = hermeticEnv(redBox.env);
		writeSandboxConfig(redBox.agentDir, [GRADED_KEY, ONOFF_KEY]);
		const redClient = openClient(redBox, redEnv);
		clients.push(redClient);
		const redOpen = await redClient.send({
			type: "open_session",
			cwd: redBox.cwd,
			provider: PROVIDER,
			modelId: GRADED,
		});
		const redSession = redOpen.data?.sessionId;
		const redSet = await redClient.send({
			type: "set_thinking_level",
			level: "xhigh",
			scope: "turn",
			sessionId: redSession,
		});
		record("RED set_thinking_level(A, xhigh, scope:turn)", redSet);
		const redAway = redClient.waitFor(
			(event) => event.message.type === "model_changed" && event.message.sessionId === redSession,
			30_000,
		);
		await redClient.send({ type: "cycle_model", sessionId: redSession });
		const redAwayEvent = await redAway;
		const redBack = redClient.waitFor(
			(event) => event.message.type === "model_changed" && event.message.sessionId === redSession,
			30_000,
		);
		await redClient.send({ type: "cycle_model", sessionId: redSession });
		const redBackEvent = await redBack;
		const redState = await redClient.send({ type: "get_state", sessionId: redSession });
		const redMemory = readSettings(redBox.agentDir).modelThinkingLevels ?? null;
		record("RED cycle", {
			away: { model: redAwayEvent.message.model?.id, thinkingLevel: redAwayEvent.message.thinkingLevel },
			back: { model: redBackEvent.message.model?.id, thinkingLevel: redBackEvent.message.thinkingLevel },
			state: { model: redState.data?.model?.id, thinkingLevel: redState.data?.thinkingLevel },
			memory: redMemory,
		});
		checks.ok(
			"RED: the memory-free (scope:turn) path writes no per-model memory",
			redMemory === null || redMemory?.[GRADED_KEY] === undefined,
			JSON.stringify(redMemory),
		);
		checks.ok(
			`RED: without memory, A returns at the global seed "${SEED_LEVEL}" and the xhigh is LOST`,
			redState.data?.model?.id === GRADED &&
				redState.data?.thinkingLevel === SEED_LEVEL &&
				redState.data?.thinkingLevel !== "xhigh",
			`${redState.data?.model?.id}/${redState.data?.thinkingLevel} (pre-fix symptom reproduced)`,
		);
		await redClient.close();
		redBox.cleanup();

		checks.ok("real credentials untouched", guard.assertUnchanged(), guard.path);
	} finally {
		for (const c of clients) {
			try {
				await c.close();
			} catch {}
		}
	}

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
