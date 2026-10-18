/**
 * Channel 3 proof: the shared GPT test decision reaches the wire on both GPT presets.
 *
 * Boots the real senpi CLI in --print mode against a fake OpenAI Responses server
 * for `gpt-5.6-sol` and `gpt-6-astra`, then inspects each captured request: the
 * developer/system message must carry the shipped `TEST_DECISION` constant (read
 * from source, so this is a shipped-copy equality rather than a sentence pin),
 * inside `## Verification`, exactly once, and none of the retired test-first
 * wording.
 *
 * Runs under bun (`bun gpt-test-decision-preset-mock-loop.mjs`): the CLI is
 * spawned from TypeScript source with the current runtime.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cliEntry, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, track } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const EVIDENCE_SLUG = "gpt-test-decision-preset-mock-loop";
const FINAL_MARKER = "SENPI-QA-GPT-TEST-DECISION-APPLIED-2b7d";
const RETIRED_WORDING = ["Work test-first", "one failing test at the seam"];
const PRESETS = [
	{ modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
	{ modelId: "gpt-6-astra", name: "GPT-6 Astra" },
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

function verificationSectionOf(systemText) {
	const start = systemText.indexOf("## Verification");
	if (start === -1) return "";
	const rest = systemText.slice(start + "## Verification".length);
	const next = rest.indexOf("\n## ");
	return next === -1 ? rest : rest.slice(0, next);
}

function occurrences(haystack, needle) {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

async function loadShippedDirective() {
	const source = join(repoRoot(), "packages/coding-agent/src/core/extensions/builtin/prompt-preset/test-decision.ts");
	const module = await import(pathToFileURL(source).href);
	return module.TEST_DECISION;
}

async function main() {
	const evidence = evidenceDir(EVIDENCE_SLUG);
	installCleanupHooks();
	const authGuard = guardRealAuth();
	const directive = await loadShippedDirective();
	check("shipped TEST_DECISION constant loads from source", typeof directive === "string" && directive.length > 32);

	for (const preset of PRESETS) {
		const sandbox = makeSandbox(`senpi-qa-test-decision-${preset.modelId}`);
		const env = hermeticEnv(sandbox.env);
		const server = await startFakeModelServer({ turns: [{ text: FINAL_MARKER }] });
		try {
			writeMockModelsJson(sandbox.agentDir, server, "openai-responses", { id: preset.modelId, name: preset.name });
			const result = await runCliWithCurrentRuntime(["--print", "--provider", "openai", "--model", preset.modelId, "Say hello"], {
				env,
				cwd: sandbox.cwd,
				timeoutMs: 60000,
			});

			check(`${preset.modelId}: --print exits 0`, result.code === 0);
			check(`${preset.modelId}: output contains the final marker`, result.stdout.includes(FINAL_MARKER));
			check(`${preset.modelId}: fake server captured exactly 1 request`, server.requests.length === 1);

			const request = server.requests[0];
			if (request) {
				check(`${preset.modelId}: request names the model`, request.body?.model === preset.modelId);
				const systemText = systemTextOf(request.body);
				const verification = verificationSectionOf(systemText);
				check(`${preset.modelId}: system prompt carries TEST_DECISION exactly once`, occurrences(systemText, directive) === 1);
				check(`${preset.modelId}: TEST_DECISION sits inside ## Verification`, verification.includes(directive));
				for (const wording of RETIRED_WORDING) {
					check(`${preset.modelId}: retired wording absent: "${wording}"`, !systemText.includes(wording));
				}
				writeFileSync(join(evidence, `${preset.modelId}-system-prompt.txt`), systemText);
				writeFileSync(join(evidence, `${preset.modelId}-request.json`), JSON.stringify(request.body, null, 2));
			}
			writeFileSync(
				join(evidence, `${preset.modelId}-stdout.txt`),
				`exit=${result.code}\n---STDOUT---\n${result.stdout}\n---STDERR---\n${result.stderr}\n`,
			);
		} finally {
			await server.stop();
			sandbox.cleanup();
		}
	}

	check("real auth store unchanged", authGuard.assertUnchanged());

	const passed = checks.filter((entry) => entry.pass).length;
	console.log(`\n${EVIDENCE_SLUG}: ${passed}/${checks.length} passed (evidence: ${evidence})`);
	process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
