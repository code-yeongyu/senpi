/**
 * Real source CLI proof: all five Astra efforts with Ultrafast on both first-party lanes, the
 * ChatGPT Subscription routing hint, and no Ultrafast on the wire for a gateway provider.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { hermeticEnv } from "./lib/mock-loop-support.mjs";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MARKER = "SENPI-QA-ASTRA-ULTRAFAST-OK";
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
const checks = [];
function check(label, pass) {
	checks.push({ label, pass: !!pass });
	console.log(`[${pass ? "PASS" : "FAIL"}] ${label}`);
}

async function main() {
	installCleanupHooks();
	const auth = guardRealAuth();
	const evidence = evidenceDir("astra-ultrafast-mock-loop");
	for (const provider of ["openai", "chatgpt-subscription", "opencode"]) {
		const firstParty = provider !== "opencode";
		for (const scenario of firstParty
			? [
					...EFFORTS.map((effort) => ({ effort, selection: "model" })),
					{ effort: "xhigh", selection: "scope" },
					{ effort: "xhigh", selection: "alias" },
				]
			: [
					{ effort: "xhigh", selection: "model" },
					{ effort: "xhigh", selection: "scope" },
				]) {
			const { effort, selection } = scenario;
			const tag = `${provider}-${effort}-${selection}`;
			const box = makeSandbox(`senpi-qa-${tag}`);
			const server = await startFakeModelServer({ turns: [{ text: MARKER }] });
			try {
				const api = provider === "chatgpt-subscription" ? "openai-codex-responses" : "openai-responses";
				writeFileSync(join(box.agentDir, "models.json"), JSON.stringify({
					providers: {
						[provider]: {
							baseUrl: server.url,
							apiKey: token,
							api,
							models: [{
								id: selection === "alias" ? "gpt-6-astra-ultrafast" : "gpt-6-astra",
							name: "GPT-6 Astra", api, baseUrl: server.url,
							...(selection === "alias" ? { upstreamModelId: "gpt-6-astra", serviceTier: "ultrafast" } : {}),
								reasoning: true, input: ["text"], contextWindow: 600000, maxTokens: 128000,
								thinkingLevelMap: { off: null, minimal: null, ...Object.fromEntries(EFFORTS.map((value) => [value, value])) },
								cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
							}],
						},
					},
				}));
				writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({
					transport: "sse", retry: { enabled: false },
					modelServiceTiers: { [`${provider}/gpt-6-astra`]: "priority" },
				}));
				const result = await runCli([
					"--print", "Say hello", selection === "scope" ? "--models" : "--model",
					selection === "alias" ? `${provider}/gpt-6-astra-ultrafast:${effort}` : `${provider}/gpt-6-astra:${effort}:ultrafast`,
					"--no-session", "--no-tools", "--no-skills", "--no-context-files",
					"--no-prompt-templates", "--no-recommended-models",
				], { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 60000 });
				check(`${tag}: CLI exit and reply`, result.code === 0 && result.stdout.includes(MARKER));
				check(`${tag}: exactly one request`, server.requests.length === 1);
				const body = server.requests[0]?.body;
				const tier = firstParty ? "ultrafast" : undefined;
				check(`${tag}: model, effort, tier ${tier ?? "absent"}`, body?.model === "gpt-6-astra" && body?.reasoning?.effort === effort && body?.service_tier === tier);
				if (provider === "chatgpt-subscription") {
					check(`${tag}: routing hint`, server.requests[0]?.routingHint === "model=gpt-6-astra;tier=ultrafast");
				}
				if (!firstParty) {
					check(`${tag}: gateway warning`, `${result.stdout}${result.stderr}`.includes("Ultrafast is only sent to OpenAI and ChatGPT Subscription"));
				}
				check(`${tag}: real auth unchanged`, auth.assertUnchanged());
				writeFileSync(join(evidence, `${tag}-request.json`), JSON.stringify(body ?? null, null, 2));
				writeFileSync(join(evidence, `${tag}-cli.json`), JSON.stringify(result, null, 2));
			} finally {
				await server.stop();
				box.cleanup();
			}
		}
	}
	writeFileSync(join(evidence, "checks.json"), JSON.stringify(checks, null, 2));
	console.log(`${checks.filter((entry) => entry.pass).length}/${checks.length} checks passed. Evidence: ${evidence}`);
	if (checks.some((entry) => !entry.pass)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
