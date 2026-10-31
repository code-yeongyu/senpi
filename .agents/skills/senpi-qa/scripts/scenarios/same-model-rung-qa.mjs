import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

/**
 * A chain entry that runs the SAME model at another thinking level must be reachable.
 *
 * The shape driven here is the one the OMO/senpi adapter sends: the head rung is the
 * chain KEY and the entries start from the second rung, so `models: [{X, reasoning: high},
 * {X, reasoning: off}]` reaches senpi as `{ "mock/mock-model": ["mock/mock-model:off"] }`.
 * The retry therefore has to move WITHIN one model. Before the change the scan consumed
 * that entry as the current position and then skipped it as a self-reference, the chain
 * was exhausted, and the turn failed on the provider error.
 *
 * The provider rejects the first request with a hard error (a 400 the engine cannot fix
 * by retrying the same request), so the only way the turn can finish is the fallback rung.
 */
const preset = API_PRESETS["openai-completions"];
const model = preset.modelId;
const marker = "SENPI-QA-SAME-MODEL-RUNG-5c1d";
const error = {
	status: 400,
	type: "invalid_request_error",
	message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"tools are not supported for this model"}}',
};

installCleanupHooks();
const guard = guardRealAuth();
const evidence = evidenceDir("same-model-rung");
const box = makeSandbox("senpi-same-model-rung");
const server = await startFakeModelServer({ turns: [{ error }, { text: marker }] });

try {
	writeMockModelsJson(
		box.agentDir,
		server,
		"openai-completions",
		// A fully graded reasoning model: "off" and "high" are both supported, so the
		// rung's level is applied instead of being clamped away.
		{ reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null } },
		{
			retry: {
				enabled: true,
				maxRetries: 0,
				baseDelayMs: 0,
				provider: { maxRetries: 0 },
				fallbackChains: { [`${preset.provider}/${model}`]: [`${preset.provider}/${model}:off`] },
			},
		},
	);

	const env = hermeticEnv(box.env);
	for (const key of Object.keys(env)) {
		if (key.endsWith("_PACKAGE_DIR")) delete env[key];
	}
	const result = await runCli(
		[
			"--provider",
			preset.provider,
			"--model",
			model,
			"--thinking",
			"high",
			"--print",
			"--no-extensions",
			"Return the scripted marker after the provider error.",
		],
		{ env, cwd: box.cwd, timeoutMs: 60000 },
	);

	const logPath = join(box.agentDir, "logs", "fallback.log");
	const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
	const rows = log
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const applied = rows.filter((row) => row.event === "fallback_applied");
	const requests = server.requests.map((request) => ({
		model: request.model,
		url: request.url,
		reasoningEffort: request.body?.reasoning_effort ?? null,
		reasoning: request.body?.reasoning ?? null,
	}));

	writeFileSync(join(evidence, "requests.json"), JSON.stringify(requests, null, 2));
	writeFileSync(join(evidence, "fallback.log"), log);
	writeFileSync(join(evidence, "stdout.txt"), result.stdout);
	writeFileSync(join(evidence, "stderr.txt"), result.stderr);

	assert.equal(result.timedOut, false, "the CLI must not time out");
	assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
	assert(result.stdout.includes(marker), "the fallback rung must answer the turn");
	assert.equal(requests.length, 2, "one rejected request, one recovered request");
	assert.deepEqual(
		requests.map((request) => request.model),
		[model, model],
		"the retry must stay on the same model instead of switching",
	);
	assert.equal(rows.some((row) => row.event === "candidates_exhausted"), false, "the chain must not exhaust");
	assert.equal(applied.length, 1, "exactly one fallback switch");
	assert.equal(applied[0].from, `${preset.provider}/${model}`);
	assert.equal(applied[0].to, `${preset.provider}/${model}`, "the switch must be within the same model");

	const [first, second] = requests;
	assert.equal(first.reasoningEffort, "high", "the head rung must run at the requested level");
	assert.notEqual(second.reasoningEffort, "high", "the fallback rung must drop the thinking level");

	writeFileSync(
		join(evidence, "result.json"),
		JSON.stringify({ exitCode: result.code, marker, requests, applied, authUnchanged: guard.assertUnchanged() }, null, 2),
	);
	const files = ["requests.json", "fallback.log", "stdout.txt", "stderr.txt", "result.json"];
	writeFileSync(
		join(evidence, "sha256sum.txt"),
		`${files
			.map((file) => `${createHash("sha256").update(readFileSync(join(evidence, file))).digest("hex")}  ${file}`)
			.join("\n")}\n`,
	);
	console.log(`PASS same model retried at another level: ${first.model}/${first.reasoningEffort} -> ${second.model}/${second.reasoningEffort}`);
	console.log(`PASS evidence=${evidence}`);
} finally {
	await server.stop();
	box.cleanup();
	assert.equal(existsSync(box.dir), false, "the sandbox must be removed");
	guard.assertUnchanged();
}
