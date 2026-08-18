/**
 * Channel 3 proof: GLM 5.3 preset is applied at runtime.
 *
 * Boots the real senpi CLI in --print mode with a mock OpenAI-compatible
 * provider serving glm-5.3, then inspects the captured request on the fake
 * model server to verify the system prompt carries the glm-5.3 preset tuning
 * ("running on GLM 5.3", NOT "running on GLM 5.2").
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	evidenceDir,
	guardRealAuth,
	makeSandbox,
	runCli,
	installCleanupHooks,
} from "./lib/common.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";

const EVIDENCE_SLUG = "glm-5.3-preset-mock-loop";
const FINAL_MARKER = "SENPI-QA-GLM53-PRESET-APPLIED-7f3a";

const checks = [];
function check(label, condition) {
	checks.push({ label, pass: !!condition });
	console.log(`[${condition ? "PASS" : "FAIL"}] ${label}`);
}

async function main() {
	const evidence = evidenceDir(EVIDENCE_SLUG);
	installCleanupHooks();
	guardRealAuth(evidence);

	const sandbox = makeSandbox("senpi-qa-glm53");
	const env = hermeticEnv(sandbox.env);

	const server = await startFakeModelServer({
		turns: [{ text: FINAL_MARKER }],
	});

	try {
		writeMockModelsJson(
			sandbox.agentDir,
			server,
			"openai-completions",
			{ id: "glm-5.3", name: "GLM-5.3" },
			{},
		);

		const result = await runCli(
			["--print", "--model", "glm-5.3", "Say hello"],
			{ env, cwd: sandbox.cwd, timeoutMs: 30000 },
		);

		check("--print exits 0", result.code === 0);
		check("--print output contains the final marker", result.stdout?.includes(FINAL_MARKER) ?? false);
		check("fake server captured exactly 1 request", server.requests.length === 1);

		if (server.requests.length > 0) {
			const req = server.requests[0];
			const messages = req.body?.messages || [];
			const systemMsg = messages.find((m) => m.role === "system") || messages[0];
			const systemText =
				typeof systemMsg?.content === "string"
					? systemMsg.content
					: JSON.stringify(systemMsg?.content || "");

			check("system prompt carries glm-5.3 preset tuning", systemText.includes("running on GLM 5.3"));
			check("system prompt does NOT carry glm-5.2 tuning", !systemText.includes("running on GLM 5.2"));
			check("system prompt carries certainty discipline", systemText.includes("absolute certainty"));

			writeFileSync(join(evidence, "system-prompt.txt"), systemText);
		}

		writeFileSync(
			join(evidence, "stdout.txt"),
			`exit=${result.code}\n---STDOUT---\n${result.stdout}\n---STDERR---\n${result.stderr}\n`,
		);
	} finally {
		await server.stop();
	}

	const passed = checks.filter((c) => c.pass).length;
	const total = checks.length;
	console.log(`\nglm-5.3-preset-mock-loop: ${passed}/${total} passed`);
	process.exitCode = passed === total ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
