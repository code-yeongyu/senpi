/**
 * Channel 3 proof: GPT-6 Sol and GPT-6 Luna reach the wire on the GPT-6 preset.
 *
 * Boots the real senpi CLI in --print mode against a fake OpenAI Responses
 * server that serves the built-in catalog rows for `gpt-6-sol` and `gpt-6-luna`,
 * then inspects each captured request: the model id and the requested reasoning
 * effort must be the ones the CLI was asked for, and the developer/system message
 * must carry the GPT-6 core (its "Asynchronous Work" and "Instructions From Files"
 * sections) and none of the GPT-5.6 core's own sections.
 *
 * Runs under bun (`bun gpt-6-family-preset-mock-loop.mjs`): the CLI is spawned
 * from TypeScript source with the current runtime, so no tsx shim is needed.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliEntry, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, track } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const EVIDENCE_SLUG = "gpt-6-family-preset-mock-loop";
const FINAL_MARKER = "SENPI-QA-GPT6-FAMILY-PRESET-APPLIED-7d2a";
const GPT6_ONLY_SECTIONS = ["## Asynchronous Work", "## Instructions From Files"];
const GPT56_ONLY_SECTIONS = ["## Manual QA Gate", "## Pragmatism & Scope"];
const SCENARIOS = [
	{ id: "gpt-6-sol", name: "GPT-6 Sol", thinking: "medium", expectedEffort: "medium" },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", thinking: "off", expectedEffort: "none" },
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
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ code: null, stdout, stderr, timedOut: true });
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut: false });
		});
		child.stdin.end();
	});
}

function systemTextOf(body) {
	if (typeof body?.instructions === "string") return body.instructions;
	const input = Array.isArray(body?.input) ? body.input : [];
	const systemItems = input.filter((item) => item?.role === "developer" || item?.role === "system");
	return systemItems
		.map((item) => (typeof item.content === "string" ? item.content : (item.content ?? []).map((part) => part?.text ?? "").join("\n")))
		.join("\n");
}

async function runScenario(scenario, evidence, authGuard) {
	const sandbox = makeSandbox(`senpi-qa-${scenario.id}`);
	const env = hermeticEnv(sandbox.env);
	const server = await startFakeModelServer({ turns: [{ text: FINAL_MARKER }] });
	try {
		writeMockModelsJson(sandbox.agentDir, server, "openai-responses", { id: scenario.id, name: scenario.name, reasoning: true });

		const result = await runCliWithCurrentRuntime(
			["--print", "--provider", "openai", "--model", scenario.id, "--thinking", scenario.thinking, "Say hello"],
			{ env, cwd: sandbox.cwd, timeoutMs: 60000 },
		);

		check(`${scenario.id}: --print exits 0`, result.code === 0);
		check(`${scenario.id}: --print output contains the final marker`, result.stdout.includes(FINAL_MARKER));
		check(`${scenario.id}: fake server captured exactly 1 request`, server.requests.length === 1);

		const request = server.requests[0];
		if (request) {
			check(`${scenario.id}: request names ${scenario.id}`, request.body?.model === scenario.id);
			check(
				`${scenario.id}: request carries reasoning.effort=${scenario.expectedEffort}`,
				request.body?.reasoning?.effort === scenario.expectedEffort,
			);
			const systemText = systemTextOf(request.body);
			check(`${scenario.id}: request carries a developer/system message`, systemText.length > 0);
			for (const section of GPT6_ONLY_SECTIONS) {
				check(`${scenario.id}: system prompt carries the GPT-6 section ${section}`, systemText.includes(section));
			}
			for (const section of GPT56_ONLY_SECTIONS) {
				check(`${scenario.id}: system prompt does NOT carry the GPT-5.6 section ${section}`, !systemText.includes(section));
			}
			check(`${scenario.id}: system prompt does not name Astra`, !/\bAstra\b/.test(systemText));
			writeFileSync(join(evidence, `${scenario.id}-system-prompt.txt`), systemText);
			writeFileSync(join(evidence, `${scenario.id}-request.json`), JSON.stringify(request.body, null, 2));
		}

		writeFileSync(
			join(evidence, `${scenario.id}-stdout.txt`),
			`exit=${result.code}\n---STDOUT---\n${result.stdout}\n---STDERR---\n${result.stderr}\n`,
		);
		check(`${scenario.id}: real auth store unchanged`, authGuard.assertUnchanged());
	} finally {
		await server.stop();
		sandbox.cleanup();
	}
}

async function main() {
	const evidence = evidenceDir(EVIDENCE_SLUG);
	installCleanupHooks();
	const authGuard = guardRealAuth();

	for (const scenario of SCENARIOS) {
		await runScenario(scenario, evidence, authGuard);
	}

	const passed = checks.filter((entry) => entry.pass).length;
	console.log(`\n${EVIDENCE_SLUG}: ${passed}/${checks.length} passed (evidence: ${evidence})`);
	process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
