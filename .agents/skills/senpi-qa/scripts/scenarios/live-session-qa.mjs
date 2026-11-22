#!/usr/bin/env node
// LIVE harness (plan QX3 / SC-LIVE, P0-05g): one long multi-tool session through the real CLI (--mode rpc, persisted
// session, CLI child on Bun or the compiled binary) in the fixture task repo, metered against a hard token budget and
// judged by the SC-LIVE invariants (lib/live-invariants.mjs).
//
//   live (owner nodes LIVE-P<n> / FINAL-LIVE only; needs SENPI_LIVE_SESSION_QA=1 and the operator's credentials):
//     node .agents/skills/senpi-qa/scripts/scenarios/live-session-qa.mjs --placement fused --model <provider>/<id> \
//       --budget 1000000 --task-extension <sub-agent component path> --evidence <slug> \
//       [--reference <LIVE-P0 receipt.json>] [--compare-with <receipt.json,...>] [--child binary:<path>]
//   self-test (no credentials, no network; the fake model server plays the model):
//     node .agents/skills/senpi-qa/scripts/scenarios/live-session-qa.mjs --self-test [--evidence <slug>]
//
// Exit 0 only when every invariant passes (live) or the self-test's expectations all hold.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LICENSE_ANSWER } from "../../scenarios/live-session/fixture/check.mjs";
import { LIVE_PROMPTS } from "../../scenarios/live-session/fixture/prompts.mjs";
import { runSelfTest } from "../../scenarios/live-session/fixture/support/self-test.mjs";
import { installProviderCredential } from "../../scenarios/live-session/fixture/support/live-credentials.mjs";
import { printChecks, writeEvidence } from "../../scenarios/live-session/fixture/support/report.mjs";
import { startRecordingProxy } from "../../scenarios/live-session/fixture/support/recording-proxy.mjs";
import { buildRunRecord } from "../../scenarios/live-session/fixture/support/run-record.mjs";
import { setUpSandbox } from "../../scenarios/live-session/fixture/support/sandbox-setup.mjs";
import { driveSession } from "../../scenarios/live-session/fixture/support/session-driver.mjs";
import { childRuntime, guardRealAuth, installCleanupHooks } from "../lib/common.mjs";
import { evaluateLiveRun, MAX_BUDGET } from "../lib/live-invariants.mjs";
import { ownerCommand } from "../lib/owner-receipt.mjs";

/** Placements whose producers come later in the plan, or that are gated on Q's C6 pick: refused, never a PASS. */
const NOT_AVAILABLE = {
	"split-local": "DEFERRED(S27a): its producer has not landed",
	"split-remote": "DEFERRED(DM1): its producer has not landed",
	"hosted-do": "GATED(C6): hosted placements run only in LIVE-P7, after the C6 custody pick",
	"hosted-bun": "GATED(C6): hosted placements run only in LIVE-P7, after the C6 custody pick",
};
const LIVE_OPT_IN = "SENPI_LIVE_SESSION_QA";
const LIVE_PROMPT_TIMEOUT_MS = 30 * 60_000;

function parseArgs(argv) {
	const value = (flag) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const evidence = value("--evidence");
	if (argv.includes("--self-test")) return { selfTest: true, evidence };
	const placement = value("--placement") ?? "fused";
	if (NOT_AVAILABLE[placement]) throw new Error(`--placement ${placement} is ${NOT_AVAILABLE[placement]}`);
	if (placement !== "fused") throw new Error(`unknown --placement ${placement}`);
	if (process.env[LIVE_OPT_IN] !== "1")
		throw new Error(`a live run spends real tokens: set ${LIVE_OPT_IN}=1 to opt in`);
	const model = /^([^/]+)\/(.+)$/.exec(value("--model") ?? "");
	if (!model) throw new Error("--model <provider>/<id> is required (the M0 pin)");
	const budget = Number(value("--budget") ?? MAX_BUDGET);
	if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET)
		throw new Error(`--budget must be 1..${MAX_BUDGET}`);
	const taskExtension = value("--task-extension");
	if (!taskExtension)
		throw new Error("--task-extension <path> is required: SC-LIVE runs a sub-agent through the task component");
	if (!evidence) throw new Error("--evidence <slug> is required for a live run");
	const upstream = URL.canParse(value("--upstream") ?? "") ? new URL(value("--upstream")) : undefined;
	if (!upstream)
		throw new Error("--upstream <provider base URL> is required: O3/O4 are recorded by a proxy in front of it");
	const receipts = (list) => (list ? list.split(",").map((path) => JSON.parse(readFileSync(path, "utf8"))) : []);
	return {
		selfTest: false,
		placement,
		provider: model[1],
		modelId: model[2],
		budget,
		taskExtension,
		evidence,
		upstream,
		reference: value("--reference") ? receipts(value("--reference"))[0].observations : undefined,
		otherPlacements: receipts(value("--compare-with")).map((r) => ({
			placement: r.placement,
			observations: r.observations,
		})),
	};
}

async function liveRun(options) {
	const setup = setUpSandbox({ label: options.placement, taskExtension: options.taskExtension });
	const credential = installProviderCredential(setup.box.agentDir, options.provider);
	const proxy = await startRecordingProxy(options.upstream.origin);
	// Route the built-in provider through the recording proxy without redefining its models (docs/models.md).
	const baseUrl = `${proxy.origin}${options.upstream.pathname.replace(/\/$/, "")}`;
	writeFileSync(
		join(setup.box.agentDir, "models.json"),
		`${JSON.stringify({ providers: { [options.provider]: { baseUrl } } }, null, 2)}\n`,
	);
	const args = [
		"--provider",
		options.provider,
		"--model",
		options.modelId,
		"--no-skills",
		...setup.extensions.flatMap((p) => ["--extension", p]),
	];
	const session = await driveSession({
		setup,
		args,
		prompts: LIVE_PROMPTS,
		budget: options.budget,
		answer: LICENSE_ANSWER,
		promptTimeoutMs: LIVE_PROMPT_TIMEOUT_MS,
	});
	await proxy.stop();
	const record = buildRunRecord({
		setup,
		session,
		proxy,
		placement: options.placement,
		otherPlacements: options.otherPlacements,
		reference: options.reference,
	});
	return { setup, session, record, credential };
}

async function main() {
	installCleanupHooks();
	const options = parseArgs(process.argv.slice(2));
	const guard = guardRealAuth();
	const command = `node .agents/skills/senpi-qa/scripts/scenarios/live-session-qa.mjs ${process.argv.slice(2).join(" ")}`;
	if (options.selfTest) {
		const passed = await runSelfTest({ evidence: options.evidence, command });
		guard.assertUnchanged();
		process.exitCode = passed ? 0 : 1;
		return;
	}
	const { setup, session, record, credential } = await liveRun(options);
	const verdict = evaluateLiveRun(record);
	printChecks(options.placement, verdict);
	guard.assertUnchanged();
	const exit = verdict.pass ? 0 : 1;
	const argv = ["node", ".agents/skills/senpi-qa/scripts/scenarios/live-session-qa.mjs", ...process.argv.slice(2)];
	const receipt = {
		command,
		commands: [ownerCommand({ manifestId: "QA.live", kind: "live", argv, childRuntime: childRuntime().label, exit })],
		kind: "live",
		placement: options.placement,
		model: { provider: options.provider, id: options.modelId, upstream: options.upstream.origin },
		credential,
		child_runtime: childRuntime().label,
		meter: session.meter,
		turns: session.turns,
		questions: session.questions,
		observations: record.observations,
		checker: record.checker,
		verdict,
	};
	const out = writeEvidence(options.evidence, receipt, session);
	setup.box.cleanup();
	process.stdout.write(
		`\nlive-session-qa ${options.placement}: ${verdict.pass ? "PASS" : "FAIL"} (${session.meter.used} tokens)\nevidence: ${out}\n`,
	);
	process.exitCode = exit;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 2;
});
