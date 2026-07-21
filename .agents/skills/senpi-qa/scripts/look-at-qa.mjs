/**
 * look-at QA — real-CLI proof that the look_at tool is vision-gated.
 *
 * Boots the real senpi CLI (with extensions) against a local fake model server
 * whose provider exposes TWO models: a text-only "main" model and a vision
 * model. The fake server records `body.tools` — the exact tool set the CLI put
 * on the wire — so we assert look_at presence/absence against real request
 * bytes, not an in-process tap. Zero real API calls, zero tokens.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { hermeticEnv } from "./lib/mock-loop-support.mjs";

const PROVIDER = "mock";
const TEXT_MODEL = "mock-text-only";
const VISION_MODEL = "mock-vision";
const API = "openai-completions";

function writeModels(agentDir, server) {
	const baseUrl = `${server.url}/chat/completions`.replace("/chat/completions", "");
	const common = {
		baseUrl,
		api: API,
		contextWindow: 128000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const config = {
		providers: {
			[PROVIDER]: {
				baseUrl,
				apiKey: "mock-key",
				api: API,
				models: [
					{ id: TEXT_MODEL, input: ["text"], ...common },
					{ id: VISION_MODEL, input: ["text", "image"], ...common },
				],
			},
		},
	};
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(config, null, 2));
}

function writeSettings(agentDir) {
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ lookAt: { enabled: true, models: [VISION_MODEL] } }, null, 2),
	);
}

async function driveWithMainModel(modelId) {
	const box = makeSandbox(`look-at-${modelId}`);
	const server = await startFakeModelServer({ turns: [{ text: "LOOK-AT-QA-DONE" }] });
	writeModels(box.agentDir, server);
	writeSettings(box.agentDir);
	const args = [
		"--provider",
		PROVIDER,
		"--model",
		modelId,
		"--no-context-files",
		"--print",
		"Say the marker.",
	];
	const result = await runCli(args, { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 120000 });
	const req = server.requests.find((r) => r.url && r.url.includes("/chat/completions"));
	const toolNames = Array.isArray(req?.tools) ? req.tools.map((t) => t.function?.name ?? t.name).filter(Boolean) : [];
	await server.stop();
	box.cleanup();
	return { result, toolNames, requestCount: server.requests.length };
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("look-at-qa.mjs");
	const guard = guardRealAuth();

	const textRun = await driveWithMainModel(TEXT_MODEL);
	checks.ok(
		"look_at exposed on a vision-unsupported main model",
		textRun.toolNames.includes("look_at"),
		`tools on wire: ${textRun.toolNames.join(", ") || "(none)"}`,
	);

	const visionRun = await driveWithMainModel(VISION_MODEL);
	checks.ok(
		"look_at hidden when the main model itself can see images",
		!visionRun.toolNames.includes("look_at"),
		`tools on wire: ${visionRun.toolNames.join(", ") || "(none)"}`,
	);

	guard.assertUnchanged();

	const dir = evidenceDir("look-at");
	writeFileSync(
		join(dir, "look-at-gating-wire-tools.json"),
		JSON.stringify(
			{
				textOnlyMain: { model: TEXT_MODEL, tools: textRun.toolNames },
				visionMain: { model: VISION_MODEL, tools: visionRun.toolNames },
			},
			null,
			2,
		),
	);
	process.stderr.write(`evidence: ${dir}\n`);
	process.exit(checks.finish() ? 0 : 1);
}

main().catch((e) => {
	process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
	process.exit(1);
});
