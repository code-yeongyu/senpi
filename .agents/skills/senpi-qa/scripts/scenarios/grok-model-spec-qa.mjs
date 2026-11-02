#!/usr/bin/env node
/**
 * Real source-CLI proof for xAI Grok model specifications.
 *
 * `--mode broken` mutates the Grok 4.6 sandbox metadata to the old
 * supportsReasoningEffort:false / map-less shape and must fail the wire check.
 * `--mode fixed` uses the corrected metadata and must pass every check.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";

const mode = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "fixed";
if (mode !== "fixed" && mode !== "broken") {
	throw new Error(`--mode must be fixed or broken, got ${mode}`);
}

const FINAL_MARKER = "SENPI-QA-GROK-MODEL-SPEC-7f3a";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function grok46(server) {
	const common = {
		id: "grok-4.6",
		name: "Grok 4.6",
		api: "openai-completions",
		baseUrl: server.url,
		reasoning: true,
		input: ["text", "image"],
		cost: COST,
		contextWindow: 500000,
		maxTokens: 500000,
	};
	if (mode === "broken") {
		return { ...common, compat: { supportsReasoningEffort: false } };
	}
	return {
		...common,
		compat: { supportsReasoningEffort: true },
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
	};
}

function nonReasoningGrok420(server) {
	return {
		id: "grok-4.20-0309-non-reasoning",
		name: "Grok 4.20 (Non-Reasoning)",
		api: "openai-completions",
		baseUrl: server.url,
		reasoning: false,
		input: ["text", "image"],
		cost: COST,
		contextWindow: 1000000,
		maxTokens: 30000,
	};
}

function reasoningGrok420(server) {
	return {
		id: "grok-4.20-0309-reasoning",
		name: "Grok 4.20 (Reasoning)",
		api: "openai-completions",
		baseUrl: server.url,
		reasoning: true,
		input: ["text", "image"],
		cost: COST,
		contextWindow: 1000000,
		maxTokens: 30000,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		},
	};
}

function writeXaiSandboxModels(agentDir, server) {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					xai: {
						baseUrl: server.url,
						apiKey: "xai-qa-mock-key",
						api: "openai-completions",
						models: [grok46(server), reasoningGrok420(server), nonReasoningGrok420(server)],
					},
				},
			},
			null,
			2,
		),
	);
}

async function main() {
	installCleanupHooks();
	const checks = createChecks(`grok-model-spec-qa.mjs --mode ${mode}`);
	const evidence = evidenceDir("grok-model-spec");
	const guard = guardRealAuth();
	const box = makeSandbox(`grok-model-spec-${mode}`);
	const env = hermeticEnv(box.env);
	const server = await startFakeModelServer({
		turns: [{ text: FINAL_MARKER }, { text: FINAL_MARKER }, { text: FINAL_MARKER }],
	});
	let serverStopped = false;
	let sandboxRemoved = false;
	let listResult;
	let grok46Result;
	let reasoningResult;
	let nonReasoningResult;

	try {
		listResult = await runCli(["--list-models", "grok-4.20", "--offline"], {
			env,
			cwd: box.cwd,
			timeoutMs: 30000,
		});
		checks.ok("built-in model list exits 0", listResult.code === 0, `exit=${listResult.code}`);
		checks.ok(
			"built-in model list includes Grok 4.20 reasoning",
			listResult.stdout.includes("grok-4.20-0309-reasoning"),
			listResult.stdout,
		);
		checks.ok(
			"built-in model list includes Grok 4.20 non-reasoning",
			listResult.stdout.includes("grok-4.20-0309-non-reasoning"),
			listResult.stdout,
		);

		writeXaiSandboxModels(box.agentDir, server);
		const sharedArgs = ["--print", "--no-session", "--no-context-files", "--no-skills", "--no-tools", "--approve"];
		grok46Result = await runCli(
			[
				"--provider",
				"xai",
				"--model",
				"grok-4.6",
				"--thinking",
				"xhigh",
				...sharedArgs,
				"Return the marker.",
			],
			{ env, cwd: box.cwd, timeoutMs: 30000 },
		);
		reasoningResult = await runCli(
			[
				"--provider",
				"xai",
				"--model",
				"grok-4.20-0309-reasoning",
				"--thinking",
				"high",
				...sharedArgs,
				"Return the marker.",
			],
			{ env, cwd: box.cwd, timeoutMs: 30000 },
		);
		nonReasoningResult = await runCli(
			[
				"--provider",
				"xai",
				"--model",
				"grok-4.20-0309-non-reasoning",
				"--thinking",
				"off",
				...sharedArgs,
				"Return the marker.",
			],
			{ env, cwd: box.cwd, timeoutMs: 30000 },
		);

		checks.ok("Grok 4.6 source CLI exits 0", grok46Result.code === 0, grok46Result.stderr);
		checks.ok("fixed-reasoning Grok source CLI exits 0", reasoningResult.code === 0, reasoningResult.stderr);
		checks.ok("non-reasoning Grok source CLI exits 0", nonReasoningResult.code === 0, nonReasoningResult.stderr);
		checks.ok("fake server captured three requests", server.requests.length === 3, `requests=${server.requests.length}`);

		const grok46Body = server.requests[0]?.body ?? {};
		const reasoningBody = server.requests[1]?.body ?? {};
		const nonReasoningBody = server.requests[2]?.body ?? {};
		checks.ok(
			"Grok 4.6 emits xhigh reasoning_effort",
			grok46Body.reasoning_effort === "xhigh",
			JSON.stringify(grok46Body),
		);
		checks.ok(
			"fixed-reasoning Grok omits reasoning_effort",
			!("reasoning_effort" in reasoningBody),
			JSON.stringify(reasoningBody),
		);
		checks.ok(
			"non-reasoning Grok omits reasoning_effort",
			!("reasoning_effort" in nonReasoningBody),
			JSON.stringify(nonReasoningBody),
		);

		writeFileSync(join(evidence, `list-models-${mode}.txt`), listResult.stdout);
		writeFileSync(
			join(evidence, `requests-${mode}.json`),
			JSON.stringify(
				{
					grok46: grok46Body,
					reasoning: reasoningBody,
					nonReasoning: nonReasoningBody,
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(evidence, `stdout-${mode}.txt`),
			[
				`grok46Exit=${grok46Result.code}`,
				grok46Result.stdout,
				`reasoningExit=${reasoningResult.code}`,
				reasoningResult.stdout,
				`nonReasoningExit=${nonReasoningResult.code}`,
				nonReasoningResult.stdout,
			].join("\n"),
		);
	} finally {
		await server.stop();
		serverStopped = true;
		box.cleanup();
		sandboxRemoved = !existsSync(box.dir);
	}

	checks.ok("fake server stopped", serverStopped);
	checks.ok("sandbox removed", sandboxRemoved, box.dir);
	checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);
	const passed = checks.finish();
	writeFileSync(
		join(evidence, `summary-${mode}.json`),
		JSON.stringify(
			{
				mode,
				pass: passed,
				serverStopped,
				sandboxRemoved,
				listExit: listResult?.code,
				grok46Exit: grok46Result?.code,
				reasoningExit: reasoningResult?.code,
				nonReasoningExit: nonReasoningResult?.code,
			},
			null,
			2,
		),
	);
	process.exit(passed ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
