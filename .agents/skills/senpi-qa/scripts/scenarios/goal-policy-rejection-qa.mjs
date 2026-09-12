#!/usr/bin/env node
// #1520: zero-token source-CLI QA. No server, real credentials, or provider calls.
// node .agents/skills/senpi-qa/scripts/scenarios/goal-policy-rejection-qa.mjs --self-test
// Optional: --evidence <directory>. Captures receipts even on assertion failure.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { guardRealAuth, installCleanupHooks, makeSandbox, repoRoot } from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const root = repoRoot();
const evidenceIndex = process.argv.indexOf("--evidence");
if (evidenceIndex >= 0 && !process.argv[evidenceIndex + 1]) throw new Error("--evidence needs a directory");
const out = resolve(evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : join(root,
	"local-ignore/qa-evidence/20260909-terminal-policy-goal-recovery/cli"));
const fixture = join(dirname(fileURLToPath(import.meta.url)), "goal-policy-rejection-fixture.ts");
const guard = guardRealAuth();
installCleanupHooks();
mkdirSync(out, { recursive: true });

async function runScenario(scenario) {
	const box = makeSandbox(`goal-policy-${scenario}`);
	writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
	const client = new TargetRpcClient({
		targetRoot: root,
		cwd: box.cwd,
		env: { ...hermeticEnv(box.env), SENPI_QA_POLICY_CASE: scenario },
		extraArgs: ["-e", fixture, "--provider", "faux-policy-qa", "--model", "policy-qa", "--no-model-fallback", "--approve"],
	});
	let receipt;
	try {
		const ready = await client.send({ type: "get_state" });
		assert.equal(ready.success, true, JSON.stringify(ready));
		// agent_idle is emitted only AFTER settlement's deferred turn claims drain.
		// Unlike a quiet-window sleep, this fails even when a recovery starts slowly.
		const idle = client.waitFor((event) => event.message.type === "agent_idle");
		const prompted = await client.send({ type: "prompt", message: "Run the scripted goal QA" });
		assert.equal(prompted.success, true, JSON.stringify(prompted));
		await idle;
		const snapshot = await client.send({ type: "extension_request", name: "qa.policy.snapshot", data: null });
		assert.equal(snapshot.success, true, JSON.stringify(snapshot));
		receipt = snapshot.data;
		writeFileSync(join(out, `${scenario}.json`), JSON.stringify(receipt, null, 2));
		assert.equal(receipt.pending, false);
		assert.equal(receipt.goal.id, receipt.createdGoalId);
		assert.equal(receipt.goal.objective, "QA preserve unfinished work");
		assert.equal(receipt.endings[0].stopReason, "error");
		assert.equal(receipt.endings[0].willRetry, false);
		if (scenario === "policy") {
			assert.equal(receipt.endings[0].errorMessage,
				"Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity.");
			assert.equal(receipt.calls, 2, "terminal rejection must not make a follow-up model call");
			assert.equal(receipt.continuations, 0);
			assert.equal(receipt.goal.status, "blocked");
			assert.equal(receipt.goal.consecutiveContinuations, 0);
			assert.equal(receipt.goal.unattendedContinuations, 0);
		} else {
			assert.equal(receipt.calls, 4, "infrastructure recovery must execute the completing tool turn");
			assert.equal(receipt.continuations, 1);
			assert.equal(receipt.goal.status, "complete");
		}
		console.log(`PASS ${scenario}: calls=${receipt.calls} continuations=${receipt.continuations} goal=${receipt.goal.status}`);
		return receipt;
	} finally {
		await client.close();
		writeFileSync(join(out, `${scenario}-events.json`), JSON.stringify(client.events.map(({ message }) => ({
			type: message.type,
			...(message.type === "message_end" ? { role: message.message?.role, customType: message.message?.customType } : {}),
		})), null, 2));
		writeFileSync(join(out, `${scenario}-stderr.txt`), client.stderr);
		box.cleanup();
		guard.assertUnchanged();
		console.log(`CLEANUP ${scenario}: CLI closed, sandbox removed, real auth unchanged`);
	}
}

const results = [];
for (const scenario of ["policy", "infrastructure"]) results.push(await runScenario(scenario));
writeFileSync(join(out, "result.json"), JSON.stringify({ passed: true, realProviderRequests: 0, results }, null, 2));
console.log(`PASS goal-policy-rejection QA; evidence=${out}`);
