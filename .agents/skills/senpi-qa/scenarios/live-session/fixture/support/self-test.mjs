// live-session-qa --self-test: the whole SC-LIVE path against the deterministic fake model server, no credentials.
//   1. The full 8-turn session (self-test-turns.mjs) must pass every SC-LIVE invariant.
//   2. The recording proxy must record what reached the provider: its first tool-bearing request's declarations and
//      header set (credentials as hashes) equal what the fake server received.
//   3. The budget is a hard stop: a session whose first turn reports 1.2M tokens is stopped after that turn and FAILs.
import { createChecks } from "../../../../scripts/lib/common.mjs";
import { startFakeModelServer } from "../../../../scripts/lib/fake-model-server.mjs";
import { diffNormalized } from "../../../../scripts/lib/equivalence-normalize.mjs";
import { evaluateLiveRun, MAX_BUDGET } from "../../../../scripts/lib/live-invariants.mjs";
import { API_PRESETS, writeMockModelsJson } from "../../../../scripts/lib/mock-loop-support.mjs";
import { LICENSE_ANSWER } from "../check.mjs";
import { LIVE_PROMPTS } from "../prompts.mjs";
import { selfTestTurns } from "../self-test-turns.mjs";
import { printChecks, writeEvidence } from "./report.mjs";
import { sanitizeHeaders, startRecordingProxy } from "./recording-proxy.mjs";
import { buildRunRecord, firstToolRequest } from "./run-record.mjs";
import { SELF_TEST_TASK_EXTENSION, setUpSandbox } from "./sandbox-setup.mjs";
import { driveSession } from "./session-driver.mjs";

const PROMPT_TIMEOUT_MS = 180_000;
const API = "openai-completions";

async function fakeRun(label, turns, budget, modelOverrides = {}) {
	const server = await startFakeModelServer({ turns });
	const proxy = await startRecordingProxy(server.origin);
	const setup = setUpSandbox({ label, taskExtension: SELF_TEST_TASK_EXTENSION });
	try {
		writeMockModelsJson(setup.box.agentDir, { origin: proxy.origin, url: `${proxy.origin}/v1` }, API, modelOverrides);
		const preset = API_PRESETS[API];
		const args = ["--provider", preset.provider, "--model", preset.modelId, "--no-skills"];
		args.push(...setup.extensions.flatMap((path) => ["--extension", path]));
		const session = await driveSession({
			setup,
			args,
			prompts: LIVE_PROMPTS,
			budget,
			answer: LICENSE_ANSWER,
			promptTimeoutMs: PROMPT_TIMEOUT_MS,
		});
		const extraRoots = [{ prefix: server.origin, token: "<model-server>" }];
		const record = buildRunRecord({ setup, session, proxy, placement: "fused", extraRoots });
		return { server, proxy, setup, session, record, verdict: evaluateLiveRun(record) };
	} finally {
		await proxy.stop();
		await server.stop();
		setup.box.cleanup();
	}
}

/** The proxy's first tool-bearing request against what the fake server received for it (credentials hashed on both). */
function proxyFidelity(run) {
	const received = run.server.requests.find((request) => request.method === "POST" && Array.isArray(request.tools));
	const recorded = firstToolRequest(run.proxy);
	if (!received || !recorded) return ["no recorded or received request"];
	const failures = diffNormalized(received.tools, recorded.tools).map((row) => `O3 ${row.path}`);
	failures.push(...diffNormalized(sanitizeHeaders(received.headers), recorded.headers).map((row) => `O4 ${row.path}`));
	if (!String(recorded.headers.authorization ?? "").startsWith("sha256:"))
		failures.push("O4 has no hashed authorization header");
	return failures;
}

export async function runSelfTest({ evidence, command }) {
	const checks = createChecks("live-session-qa --self-test");
	const full = await fakeRun("self-test", selfTestTurns(), MAX_BUDGET);
	printChecks("self-test", full.verdict);
	checks.ok(
		"full fake-model session passes every SC-LIVE invariant",
		full.verdict.pass,
		`${full.session.meter.used} tokens, ${full.session.turns} turns`,
	);
	const fidelity = proxyFidelity(full);
	checks.ok(
		"the proxy records O3/O4 exactly as the provider received them",
		fidelity.length === 0,
		fidelity.slice(0, 4).join("; "),
	);

	const heavy = selfTestTurns().map((turn, index) =>
		index < 2 ? { ...turn, usage: { promptTokens: 600_000 } } : turn,
	);
	// A context window far above the reported usage, so no compaction request interleaves with the scripted turns.
	const capped = await fakeRun("self-test-budget", heavy, MAX_BUDGET, { contextWindow: 10_000_000 });
	const budget = capped.verdict.checks.find((c) => c.id === "budget");
	checks.ok(
		"the budget is a hard stop: the session is stopped after the turn that crossed it, and the run FAILs",
		!capped.verdict.pass && !budget.pass && capped.session.meter.stopped && capped.session.turns === 1,
		`${capped.session.meter.used} of ${capped.session.meter.limit} tokens, ${capped.session.turns} turn(s) sent`,
	);
	const passed = checks.finish();
	if (evidence) {
		const receipt = {
			command,
			kind: "self-test",
			child_runtime: full.record.childRuntime,
			full: {
				meter: full.session.meter,
				turns: full.session.turns,
				questions: full.session.questions,
				verdict: full.verdict,
				observations: full.record.observations,
			},
			proxyFidelity: fidelity,
			budget: { meter: capped.session.meter, turns: capped.session.turns, verdict: capped.verdict },
			pass: passed,
		};
		process.stdout.write(`evidence: ${writeEvidence(evidence, receipt, full.session)}\n`);
	}
	return passed;
}
