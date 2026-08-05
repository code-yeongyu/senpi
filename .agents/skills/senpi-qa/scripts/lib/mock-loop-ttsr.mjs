import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks } from "./common.mjs";

const CTRL_SEP = ["<", "|", "sep", "|", ">"].join("");
const BANG_RUN_300 = /!{300}/;

export const TTSR_SCENARIOS = ["ttsr-collapse", "ttsr-leak", "ttsr-repetitive-turns"];

export function isTtsrScenario(name) {
	return TTSR_SCENARIOS.includes(name);
}

function check(name, pass, detail) {
	return { name, pass, detail };
}

function writeTtsrEvidence(slug, scenarioName, result, server) {
	const dir = evidenceDir(slug);
	writeFileSync(join(dir, `${scenarioName}-stdout.txt`), `${result.stdout}\n${result.stderr}`);
	writeFileSync(join(dir, `${scenarioName}-requests.json`), JSON.stringify(server.requests, null, 2));
	process.stderr.write(`evidence: ${dir}\n`);
	return dir;
}

const REPEATED_STATUS_TURNS = [
	"I read this as continue supervising the portable matrix; it has started cleanly with 1 check green and 8 still pending.",
	"I read this as continue supervising the portable matrix; it has started cleanly with 2 checks green and 7 jobs pending.",
	"I read this as continue supervising the portable matrix; it has started cleanly with 3 checks green and 6 gates pending.",
];

function writeGoalMonitorFixture(box) {
	const eventLogPath = join(box.dir, "goal-monitor-events.jsonl");
	const extensionPath = join(box.dir, "goal-monitor-extension.mjs");
	const source = `
import { appendFileSync } from "node:fs";

const eventLogPath = ${JSON.stringify(eventLogPath)};
const record = (event) => appendFileSync(eventLogPath, JSON.stringify(event) + "\\n");

export default function(pi) {
	pi.on("session_start", () => {
		pi.events?.emit("terminal_monitor_state", { activeCount: 1 });
		record({ type: "monitor_state", activeCount: 1 });
	});
	pi.on("agent_end", (event) => {
		record({ type: "agent_end", aborted: event.aborted, abortSource: event.abortSource });
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "create_goal") record({ type: "goal_created" });
	});
	pi.events?.on("goal_continuation_scheduled", (data) => {
		record({ type: "goal_continuation_scheduled", data });
	});
}
`;
	writeFileSync(extensionPath, source);
	return { extraArgs: ["--extension", extensionPath], eventLogPath };
}

function readGoalState(box) {
	const goalDir = join(box.sessionDir, "extensions", "goal");
	if (!existsSync(goalDir)) return undefined;
	const goalFile = readdirSync(goalDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(goalDir, name))
		.at(0);
	return goalFile === undefined ? undefined : JSON.parse(readFileSync(goalFile, "utf8"));
}

function readFixtureEvents(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function runRepetitiveTurnsScenario({ apiName, driveTurn, evidenceSlug, checks, guard, finalMarker, scenarioName }) {
	const { box, server, result, prepared } = await driveTurn({
		apiName,
		turns: [
			{ text: REPEATED_STATUS_TURNS[0] },
			{ toolCalls: [{ name: "create_goal", args: { objective: "Keep the live monitor wait active" } }] },
			{ text: REPEATED_STATUS_TURNS[1] },
			{ text: finalMarker },
		],
		prompt: `Report status repeatedly and finish with ${finalMarker}.`,
		extraArgs: ["--approve"],
		followUpPrompts: ["Create a Goal and continue monitoring"],
		prepareSandbox: writeGoalMonitorFixture,
		timeoutMs: 180000,
	});

	try {
		const output = `${result.stdout}\n${result.stderr}`;
		const allBodies = JSON.stringify(server.requests.map((r) => r.body ?? r.raw ?? ""));
		const goalState = readGoalState(box);
		const fixtureEvents = readFixtureEvents(prepared.eventLogPath);
		const goalCreatedIndex = fixtureEvents.findIndex((event) => event.type === "goal_created");
		const systemAbortIndex = fixtureEvents.findIndex(
			(event) => event.type === "agent_end" && event.aborted === true && event.abortSource === "system",
		);
		const recoveryIndex = fixtureEvents.findIndex(
			(event, index) => index > systemAbortIndex && event.type === "agent_end" && event.abortSource === undefined,
		);
		const monitorScheduleIndex = fixtureEvents.findIndex(
			(event, index) =>
				index > goalCreatedIndex &&
				event.type === "goal_continuation_scheduled" &&
				event.data?.activeMonitorCount === 1,
		);
		checks.ok(`${scenarioName}: CLI exits zero`, result.code === 0 && !result.timedOut, `code=${result.code}`);
		checks.ok(
			`${scenarioName}: cross-turn repetition triggered an extra bounded turn`,
			server.requests.length === 4,
			`requests=${server.requests.length}`,
		);
		checks.ok(
			`${scenarioName}: repetitive-turns system-interrupt injected into a later request`,
			allBodies.includes("repetitive-turns"),
			`interruptPresent=${allBodies.includes("repetitive-turns")}`,
		);
		checks.ok(`${scenarioName}: recovery answer returned`, output.includes(finalMarker), `marker=${finalMarker}`);
		const hiddenRuntimeError = /Agent is already processing|Extension error \([^)]*\): This extension ctx is stale/.test(output);
		checks.ok(
			`${scenarioName}: no hidden runtime or stale-context errors`,
			!hiddenRuntimeError,
			`hiddenRuntimeError=${hiddenRuntimeError}`,
		);
		checks.ok(
			`${scenarioName}: final persisted Goal remains active`,
			goalState?.goal?.status === "active",
			`status=${goalState?.goal?.status ?? "missing"}`,
		);
		checks.ok(
			`${scenarioName}: active Goal exists before the TTSR system abort`,
			goalCreatedIndex >= 0 && systemAbortIndex > goalCreatedIndex,
			`goalCreatedIndex=${goalCreatedIndex} systemAbortIndex=${systemAbortIndex}`,
		);
		checks.ok(
			`${scenarioName}: TTSR system abort is followed by recovery with monitor wait live`,
			recoveryIndex > systemAbortIndex &&
				monitorScheduleIndex > goalCreatedIndex &&
				monitorScheduleIndex < recoveryIndex,
			`systemAbortIndex=${systemAbortIndex} recoveryIndex=${recoveryIndex} monitorScheduleIndex=${monitorScheduleIndex}`,
		);
		guard.assertUnchanged();
		if (evidenceSlug) {
			const dir = writeTtsrEvidence(evidenceSlug, scenarioName, result, server);
			writeFileSync(join(dir, `${scenarioName}-state.json`), JSON.stringify({ goalState, fixtureEvents }, null, 2));
		}
	} finally {
		await server.stop();
		box.cleanup();
	}
	process.exit(checks.finish() ? 0 : 1);
}

export async function runTtsrScenario({ scenarioName, apiName, driveTurn, evidenceSlug }) {
	installCleanupHooks();
	const checks = createChecks(`mock-loop.mjs --scenario ${scenarioName} --api ${apiName}`);
	const guard = guardRealAuth();
	const finalMarker = `SENPI-QA-${scenarioName.toUpperCase().replace(/-/g, "_")}-FINAL`;
	if (scenarioName === "ttsr-repetitive-turns") {
		return runRepetitiveTurnsScenario({ apiName, driveTurn, evidenceSlug, checks, guard, finalMarker, scenarioName });
	}
	const collapse = scenarioName === "ttsr-collapse";
	const firstTurn = collapse
		? { reasoning: `analyzing the problem ${"!".repeat(600)}`, chunks: 40 }
		: { reasoning: `Thinking... ${CTRL_SEP} ${CTRL_SEP} ${CTRL_SEP} trailing garbage ${"x".repeat(400)}`, chunks: 20 };
	const { box, server, result } = await driveTurn({
		apiName,
		turns: [firstTurn, { text: finalMarker }],
		prompt: `Analyze briefly and finish with ${finalMarker}.`,
		extraArgs: ["--approve"],
		timeoutMs: 120000,
	});

	try {
		const output = `${result.stdout}\n${result.stderr}`;
		const replayBody = JSON.stringify(server.requests[1]?.body ?? server.requests[1]?.raw ?? "");
		checks.ok(`${scenarioName}: CLI exits zero`, result.code === 0 && !result.timedOut, `code=${result.code}`);
		checks.ok(
			`${scenarioName}: exactly two model turns (abort + one bounded recovery)`,
			server.requests.length === 2,
			`requests=${server.requests.length}`,
		);
		if (collapse) {
			checks.ok(
				"ttsr-collapse: truncated garbage absent from recovery request",
				!BANG_RUN_300.test(replayBody),
				`bangRun300=${BANG_RUN_300.test(replayBody)}`,
			);
		} else {
			checks.ok(
				"ttsr-leak: leaked control tokens absent from retry request",
				!replayBody.includes(CTRL_SEP),
				`sepPresent=${replayBody.includes(CTRL_SEP)}`,
			);
		}
		checks.ok(`${scenarioName}: recovery answer returned`, output.includes(finalMarker), `marker=${finalMarker}`);
		guard.assertUnchanged();
		if (evidenceSlug) writeTtsrEvidence(evidenceSlug, scenarioName, result, server);
	} finally {
		await server.stop();
		box.cleanup();
	}
	process.exit(checks.finish() ? 0 : 1);
}
