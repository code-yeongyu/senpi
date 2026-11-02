/**
 * Channel 3 proof for GPT-6.1 Sol (senpi#2390): the real senpi CLI in --print mode against a
 * fake OpenAI Responses server serving `gpt-6.1-sol` and its Fast variant, then the captured
 * request bytes are checked: model id, reasoning.effort, service_tier for the Fast row, the
 * GPT-6 preset sections, and that `--thinking off` never puts `reasoning.effort: none` on the
 * wire because the model documents no such effort.
 *
 * Runs under bun (`bun gpt-6-1-sol-preset-mock-loop.mjs`).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliEntry, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, track } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const EVIDENCE_SLUG = "gpt-6-1-sol-preset-mock-loop";
const FINAL_MARKER = "SENPI-QA-GPT61-SOL-PRESET-APPLIED-4c1e";
const GPT6_ONLY_SECTIONS = ["## Asynchronous Work", "## Instructions From Files"];
const GPT56_ONLY_SECTIONS = ["## Manual QA Gate", "## Pragmatism & Scope"];
const NO_APOLOGY_RULE = "Apologize or fault yourself only for an avoidable mistake of your own";
const SCENARIOS = [
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", thinking: "medium", expectedEffort: "medium", expectedWireModel: "gpt-6.1-sol" },
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", thinking: "xhigh", expectedEffort: "xhigh", expectedWireModel: "gpt-6.1-sol" },
	// `none` is undocumented for 6.1 Sol: the CLI clamps `off` to the lowest real effort instead of sending none.
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", thinking: "off", forbiddenEffort: "none", expectedWireModel: "gpt-6.1-sol" },
	{
		id: "gpt-6.1-sol-fast",
		name: "GPT-6.1 Sol Fast",
		thinking: "medium",
		expectedEffort: "medium",
		expectedWireModel: "gpt-6.1-sol",
		expectedServiceTier: "priority",
		overrides: { upstreamModelId: "gpt-6.1-sol", serviceTier: "priority" },
	},
];

const checks = [];
function check(label, condition) {
	checks.push({ label, pass: !!condition });
	console.log(`[${condition ? "PASS" : "FAIL"}] ${label}`);
}

function runCliWithCurrentRuntime(args, { env, cwd, timeoutMs }) {
	return new Promise((resolve) => {
		const root = repoRoot();
		const child = track(spawn(process.execPath, [cliEntry(root), ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }));
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, stdout, stderr, timedOut: true }); }, timeoutMs);
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut: false }); });
		child.stdin.end();
	});
}

function systemTextOf(body) {
	if (typeof body?.instructions === "string") return body.instructions;
	const input = Array.isArray(body?.input) ? body.input : [];
	return input
		.filter((item) => item?.role === "developer" || item?.role === "system")
		.map((item) => (typeof item.content === "string" ? item.content : (item.content ?? []).map((part) => part?.text ?? "").join("\n")))
		.join("\n");
}

async function runScenario(scenario, evidence, authGuard) {
	const tag = `${scenario.id}@${scenario.thinking}`;
	const sandbox = makeSandbox(`senpi-qa-${scenario.id}-${scenario.thinking}`);
	const env = hermeticEnv(sandbox.env);
	const server = await startFakeModelServer({ turns: [{ text: FINAL_MARKER }] });
	try {
		writeMockModelsJson(sandbox.agentDir, server, "openai-responses", { id: scenario.id, name: scenario.name, reasoning: true, ...(scenario.overrides ?? {}) });

		const result = await runCliWithCurrentRuntime(
			["--print", "--provider", "openai", "--model", scenario.id, "--thinking", scenario.thinking, "Say hello"],
			{ env, cwd: sandbox.cwd, timeoutMs: 90000 },
		);

		check(`${tag}: --print exits 0`, result.code === 0);
		check(`${tag}: --print output contains the final marker`, result.stdout.includes(FINAL_MARKER));
		check(`${tag}: fake server captured exactly 1 request`, server.requests.length === 1);

		const request = server.requests[0];
		if (request) {
			check(`${tag}: request names ${scenario.expectedWireModel} on the wire`, request.body?.model === scenario.expectedWireModel);
			if (scenario.expectedEffort) {
				check(`${tag}: request carries reasoning.effort=${scenario.expectedEffort}`, request.body?.reasoning?.effort === scenario.expectedEffort);
			}
			if (scenario.forbiddenEffort) {
				check(`${tag}: request never carries reasoning.effort=${scenario.forbiddenEffort} (got ${JSON.stringify(request.body?.reasoning?.effort)})`, request.body?.reasoning?.effort !== scenario.forbiddenEffort);
			}
			if (scenario.expectedServiceTier) {
				check(`${tag}: request carries service_tier=${scenario.expectedServiceTier}`, request.body?.service_tier === scenario.expectedServiceTier);
			} else {
				check(`${tag}: request carries no service_tier`, request.body?.service_tier === undefined);
			}
			const systemText = systemTextOf(request.body);
			check(`${tag}: request carries a developer/system message`, systemText.length > 0);
			for (const section of GPT6_ONLY_SECTIONS) check(`${tag}: system prompt carries the GPT-6 section ${section}`, systemText.includes(section));
			for (const section of GPT56_ONLY_SECTIONS) check(`${tag}: system prompt does NOT carry the GPT-5.6 section ${section}`, !systemText.includes(section));
			check(`${tag}: system prompt carries the no-reflexive-apology rule`, systemText.includes(NO_APOLOGY_RULE));
			check(`${tag}: system prompt does not name Astra`, !/\bAstra\b/.test(systemText));
			writeFileSync(join(evidence, `${scenario.id}-${scenario.thinking}-system-prompt.txt`), systemText);
			writeFileSync(join(evidence, `${scenario.id}-${scenario.thinking}-request.json`), JSON.stringify(request.body, null, 2));
		}
		writeFileSync(join(evidence, `${scenario.id}-${scenario.thinking}-stdout.txt`), `exit=${result.code}\n---STDOUT---\n${result.stdout}\n---STDERR---\n${result.stderr}\n`);
		check(`${tag}: real auth store unchanged`, authGuard.assertUnchanged());
	} finally {
		await server.stop();
		sandbox.cleanup();
	}
}

async function main() {
	const evidence = evidenceDir(EVIDENCE_SLUG);
	installCleanupHooks();
	const authGuard = guardRealAuth();
	for (const scenario of SCENARIOS) await runScenario(scenario, evidence, authGuard);
	const passed = checks.filter((entry) => entry.pass).length;
	console.log(`\n${EVIDENCE_SLUG}: ${passed}/${checks.length} passed (evidence: ${evidence})`);
	process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
