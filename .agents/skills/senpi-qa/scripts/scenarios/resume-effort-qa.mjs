// Run from the repository root: node --import tsx .agents/skills/senpi-qa/scripts/scenarios/resume-effort-qa.mjs --self-test
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeResumeEffortFixture } from "../../../../../packages/coding-agent/test/suite/resume-effort-fixtures.ts";
import { evidenceDir, guardRealAuth, makeSandbox, repoRoot } from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const slugIndex = process.argv.indexOf("--evidence");
const evidence = evidenceDir(slugIndex < 0 ? "resume-effort" : process.argv[slugIndex + 1]);
const guard = guardRealAuth();
const rows = [];
const scenarios = [
	{ name: "orphan-recovery", expected: "xhigh", baseline: "xhigh", inline: ["xhigh"] },
	{ name: "explicit-thinking", args: ["--thinking", "high"], expected: "high", baseline: "high", inline: ["xhigh", "high"] },
	// The shipped Astra map excludes off/minimal: an explicit off clamps to low.
	{ name: "explicit-off-clamped", args: ["--thinking", "off"], expected: "low", baseline: "low", inline: ["xhigh", "low"] },
	{ name: "model-suffix", args: ["--model", "openai/gpt-6-astra:high"], expected: "high", baseline: "high", inline: ["xhigh", "high"] },
	{ name: "intact-cache-baseline", intact: true, expected: "xhigh", baseline: "medium", inline: ["xhigh"] },
	{ name: "intact-explicit-override", intact: true, args: ["--thinking", "high"], expected: "high", baseline: "medium", inline: ["xhigh", "high"] },
	{ name: "later-selection", later: "high", expected: "high", baseline: "high", inline: ["xhigh", "high"] },
];

for (const scenario of scenarios) {
	const box = makeSandbox("resume-effort");
	const server = await startFakeModelServer({ turns: [{ text: "RESUME_EFFORT_QA_OK" }] });
	let client;
	try {
		writeMockModelsJson(box.agentDir, server, "openai-responses", {
			id: "gpt-6-astra", reasoning: true, contextWindow: 600_000, maxTokens: 32_000,
		});
		const settingsPath = join(box.agentDir, "settings.json");
		const settings = JSON.stringify({
			defaultProvider: "openai", defaultModel: "gpt-6-astra", defaultThinkingLevel: "minimal",
			modelThinkingLevels: { "openai/gpt-6-astra": "low" },
			compaction: { enabled: false }, retry: { enabled: false },
		});
		writeFileSync(settingsPath, settings);
		const manager = writeResumeEffortFixture(box.cwd, { provider: "openai", intact: scenario.intact });
		if (scenario.later) manager.appendThinkingLevelChange(scenario.later, { level: scenario.later, source: "explicit" });
		const sessionFile = manager.getSessionFile();
		assert.ok(sessionFile);
		client = new TargetRpcClient({
			env: hermeticEnv(box.env), cwd: box.cwd, targetRoot: repoRoot(),
			extraArgs: ["--session", sessionFile, "--no-extensions", "--no-skills", "--no-tools", ...(scenario.args ?? [])],
		});
		const state = await client.send({ type: "get_state" });
		assert.equal(state.success, true);
		assert.equal(state.data.thinkingLevel, scenario.expected);
		assert.equal(state.data.model.id, "gpt-6-astra");
		assert.equal(state.data.sessionId, manager.getSessionId());
		// Subscribe before triggering the turn; no sleeps or polling.
		const completed = client.waitFor((event) => event.message.type === "agent_end");
		const [ack] = await Promise.all([client.send({ type: "prompt", message: "SYNTHETIC_QA_PROMPT" }), completed]);
		assert.equal(ack.success, true);
		const reply = await client.send({ type: "get_last_assistant_text" });
		assert.equal(reply.data.text, "RESUME_EFFORT_QA_OK");
		const requests = server.requests.filter((request) => request.method === "POST");
		assert.equal(requests.length, 1);
		const request = requests[0].body;
		assert.equal(request.model, "gpt-6-astra");
		const inline = request.input.filter((item) => item.type === "configuration_update").map((item) => item.reasoning.effort);
		assert.deepEqual(inline, scenario.inline);
		assert.equal(request.reasoning?.effort, scenario.baseline);
		await client.close();
		assert.equal(client.child.exitCode, 0);
		if (!scenario.args) assert.equal(readFileSync(settingsPath, "utf8"), settings);
		// Reopen the same on-disk history without overrides to prove durable precedence.
		client = new TargetRpcClient({
			env: hermeticEnv(box.env), cwd: box.cwd, targetRoot: repoRoot(),
			extraArgs: ["--session", sessionFile, "--no-extensions", "--no-skills", "--no-tools"],
		});
		const reopened = await client.send({ type: "get_state" });
		assert.equal(reopened.success, true);
		assert.equal(reopened.data.thinkingLevel, scenario.expected);
		await client.close();
		assert.equal(client.child.exitCode, 0);
		const row = {
			name: scenario.name, pass: true, localEffort: state.data.thinkingLevel,
			requestBaseline: request.reasoning?.effort, inlineEfforts: inline,
			requests: requests.length, exitCode: client.child.exitCode, reopenedEffort: reopened.data.thinkingLevel,
		};
		rows.push(row);
		console.log(JSON.stringify(row));
	} finally {
		if (client && client.child.exitCode === null) await client.close();
		await server.stop();
		box.cleanup();
	}
}
assert.equal(guard.assertUnchanged(), true);
writeFileSync(join(evidence, "resume-effort-qa.json"), `${JSON.stringify({ rows, realAuthUnchanged: true }, null, 2)}\n`);
console.log(`PASS: ${rows.length} real source CLI --session/RPC scenarios; evidence ${evidence}`);
