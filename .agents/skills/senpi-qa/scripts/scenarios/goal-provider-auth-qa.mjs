#!/usr/bin/env node
// #2293: zero-token source-CLI QA for a goal that hits a persistent provider 403.
// A local fake stands in for GitHub Copilot (kimi-k3): the first request creates
// the goal, every later request is answered 403 with an EMPTY body, the shape the
// Copilot endpoint returned in the report. The goal must block on the first 403.
// node .agents/skills/senpi-qa/scripts/scenarios/goal-provider-auth-qa.mjs [--target <senpi root>] [--evidence <dir>]
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { guardRealAuth, installCleanupHooks, makeSandbox, repoRoot } from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const argValue = (flag) => {
	const index = process.argv.indexOf(flag);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (!value) throw new Error(`${flag} needs a value`);
	return resolve(value);
};
const targetRoot = argValue("--target") ?? repoRoot();
const out = argValue("--evidence") ?? join(repoRoot(), "local-ignore/qa-evidence/20260928-goal-provider-auth/cli");
const guard = guardRealAuth();
installCleanupHooks();
mkdirSync(out, { recursive: true });

function completionChunk(delta, finishReason = null) {
	const chunk = { id: "qa", object: "chat.completion.chunk", created: 0, model: "kimi-k3", choices: [{ index: 0, delta, finish_reason: finishReason }] };
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

function writeToolCall(res, id, name, args) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const call = { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } };
	res.write(completionChunk({ role: "assistant", tool_calls: [call] }));
	res.write(completionChunk({}, "tool_calls"));
	res.end("data: [DONE]\n\n");
}

function writeText(res, text) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write(completionChunk({ role: "assistant", content: text }));
	res.write(completionChunk({}, "stop"));
	res.end("data: [DONE]\n\n");
}

// Script: create the goal, then 403 with an empty body until `fixAuth()` (the
// user's re-login), then complete the goal and answer the follow-up.
function startFakeCopilot() {
	const requests = [];
	let authFixedAt;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			requests.push({ method: req.method, url: req.url, at: Date.now() });
			if (requests.length === 1) return writeToolCall(res, "qa-create", "create_goal", { objective: "QA migrate the repository" });
			if (authFixedAt === undefined) {
				res.writeHead(403);
				res.end();
				return;
			}
			if (requests.length === authFixedAt + 1) return writeToolCall(res, "qa-complete", "update_goal", { status: "complete" });
			return writeText(res, "QA migration complete");
		});
	});
	return new Promise((resolveServer) => {
		server.listen(0, "127.0.0.1", () => {
			resolveServer({
				origin: `http://127.0.0.1:${server.address().port}`,
				requests,
				forbidden: () => (authFixedAt ?? requests.length) - 1,
				fixAuth: () => {
					authFixedAt = requests.length;
				},
				stop: () => new Promise((r) => server.close(() => r())),
			});
		});
	});
}

function readGoalFile(dir) {
	const files = readdirSync(dir, { recursive: true }).filter((path) => /extensions[\\/]goal[\\/][^\\/]+\.json$/.test(path) && !path.endsWith(".history.json"));
	assert.equal(files.length, 1, `expected one goal store, found ${JSON.stringify(files)}`);
	return JSON.parse(readFileSync(join(dir, files[0]), "utf8")).goal;
}

const fake = await startFakeCopilot();
const box = makeSandbox("goal-provider-auth");
writeFileSync(join(box.agentDir, "models.json"), JSON.stringify({ providers: { "github-copilot": { baseUrl: fake.origin } } }));
const client = new TargetRpcClient({
	targetRoot,
	cwd: box.cwd,
	env: { ...hermeticEnv(box.env), COPILOT_GITHUB_TOKEN: "qa-dummy-copilot-token" },
	extraArgs: ["--provider", "github-copilot", "--model", "kimi-k3", "--no-model-fallback", "--approve"],
});
let receipt;
try {
	const ready = await client.send({ type: "get_state" });
	assert.equal(ready.success, true, JSON.stringify(ready));
	// agent_idle fires only after every settled recovery drains, so a cap loop
	// shows up here as eight extra 403 requests before it resolves.
	const idle = client.waitFor((event) => event.message.type === "agent_idle", 180_000);
	const prompted = await client.send({ type: "prompt", message: "Start the migration goal" });
	assert.equal(prompted.success, true, JSON.stringify(prompted));
	await idle;
	const goal = readGoalFile(box.dir);
	const warnings = client.events
		.map(({ message }) => message)
		.filter((message) => message.type === "extension_ui_request" && message.method === "notify" && message.notifyType === "warning")
		.map((message) => message.message);
	receipt = {
		target: targetRoot,
		providerRequests: fake.requests.length,
		forbiddenResponses: fake.forbidden(),
		goal: { status: goal.status, blockedReason: goal.blockedReason, consecutiveContinuations: goal.consecutiveContinuations },
		warnings,
	};
	writeFileSync(join(out, "result.json"), JSON.stringify(receipt, null, 2));
	console.log(JSON.stringify(receipt, null, 2));
	assert.equal(receipt.forbiddenResponses, 1, "the goal must stop after the first 403 instead of retrying it");
	assert.equal(goal.status, "blocked");
	assert.equal(goal.consecutiveContinuations ?? 0, 0);
	assert.equal(warnings.length, 1, "exactly one auth warning");
	assert.match(warnings[0], /github-copilot\/kimi-k3/);
	assert.match(warnings[0], /\/login github-copilot/);
	assert.doesNotMatch(warnings.join("\n"), /continuation cap reached/);
	console.log(`PASS goal-provider-auth block: requests=${receipt.providerRequests} goal=${goal.status}`);

	// The user fixes the login and sends one message: the goal must resume.
	fake.fixAuth();
	const resumedIdle = client.waitFor((event) => event.message.type === "agent_idle", 180_000);
	const resumed = await client.send({ type: "prompt", message: "Logged in again, continue" });
	assert.equal(resumed.success, true, JSON.stringify(resumed));
	await resumedIdle;
	const finished = readGoalFile(box.dir);
	receipt.afterRelogin = { providerRequests: fake.requests.length, goalStatus: finished.status };
	writeFileSync(join(out, "result.json"), JSON.stringify(receipt, null, 2));
	console.log(JSON.stringify(receipt.afterRelogin));
	assert.equal(finished.status, "complete", "the next message after re-login resumes and finishes the goal");
	console.log(`PASS goal-provider-auth resume: requests=${fake.requests.length} goal=${finished.status}`);
} finally {
	await client.close();
	await fake.stop();
	writeFileSync(join(out, "events.json"), JSON.stringify(client.events.map(({ message }) => ({ type: message.type, method: message.method, message: message.method === "notify" ? message.message : undefined })), null, 2));
	writeFileSync(join(out, "stderr.txt"), client.stderr);
	box.cleanup();
	guard.assertUnchanged();
	console.log("CLEANUP goal-provider-auth: CLI closed, fake server stopped, sandbox removed, real auth unchanged");
}
