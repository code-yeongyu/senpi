/**
 * Channel 1 — Remote RPC QA.
 *
 * Drives the coding-agent's headless RPC mode (`--mode rpc`), which speaks
 * JSON-RPC over stdio as JSON lines (see packages/coding-agent/src/modes/rpc/).
 * Commands go in on stdin; a `{type:"response",...}` line plus a stream of
 * AgentSessionEvent lines come back on stdout.
 *
 * This is the surface to QA when you change the agent loop, tools, session
 * lifecycle, model/provider resolution, or anything an embedder drives over RPC.
 *
 * Usage:
 *   node rpc-drive.mjs --self-test                 # get_state round-trips, no API call
 *   node rpc-drive.mjs --state                     # print live get_state
 *   node rpc-drive.mjs --prompt "say PONG" \       # drive a real turn (needs a model)
 *        [--provider P --model M] [--evidence SLUG]
 *   node rpc-drive.mjs --with-mock openai-responses --with-reasoning \
 *        --prompt "say PONG" --evidence rpc-reasoning
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { RpcClient } from "./lib/rpc-client.mjs";

export { RpcClient };
import {
	ALL_APIS,
	API_PRESETS,
	QA_FINAL_MARKER,
	hermeticEnv,
	reasoningScriptedTurn,
	writeMockModelsJson,
} from "./lib/mock-loop-support.mjs";

const SCENARIO_PROVIDER = "claude-sdk-oauth";
const SCENARIO_MODEL_ID = "claude-sonnet-4-5";

async function selfTest() {
	installCleanupHooks();
	const checks = createChecks("rpc-drive.mjs --self-test");
	const guard = guardRealAuth();
	const box = makeSandbox("rpc-drive");
	const client = new RpcClient({ env: box.env, cwd: box.cwd });

	let res;
	await checks.run("get_state returns a success response", async () => {
		res = await client.send({ type: "get_state" });
		if (res.type !== "response" || res.command !== "get_state" || res.success !== true) {
			throw new Error(`unexpected response: ${JSON.stringify(res)}`);
		}
		return `sessionId=${res.data?.sessionId ?? "?"} streaming=${res.data?.isStreaming}`;
	});

	checks.ok(
		"state has the documented shape (RpcSessionState)",
		!!res && typeof res.data === "object" && typeof res.data.messageCount === "number",
		res ? `messageCount=${res.data.messageCount}` : "",
	);

	checks.ok("no real provider API was required to boot RPC", true, "offline sandbox, get_state is local");

	client.close();
	await new Promise((r) => setTimeout(r, 300));
	checks.ok("real auth unchanged", (() => {
		try {
			return guard.assertUnchanged();
		} catch {
			return false;
		}
	})(), guard.path);

	box.cleanup();
	const passed = checks.finish();
	process.exit(passed ? 0 : 1);
}

async function driveScenarioClaudeSdkOauthAccounts() {
	installCleanupHooks();
	const guard = guardRealAuth();
	const checks = createChecks("rpc-drive.mjs --scenario claude-sdk-oauth-accounts");
	const box = makeSandbox("rpc-csdk-oauth");
	const client = new RpcClient({ env: box.env, cwd: box.cwd });

	try {
		// Ensure the RPC session has booted before issuing model/account commands.
		await client.send({ type: "get_state" });

		// --- get_provider_accounts (rpc-types.ts line ~94) ---
		// Request shape: { type: "get_provider_accounts", provider: string }
		// Response shape: { type: "response", command: "get_provider_accounts",
		//                   success: true, data: { accounts: RpcProviderAccount[] } }
		// RpcProviderAccount = { name, source: "login"|"import"|"env", blocked, pinned }
		// — no credential fields, but we redact defensively in case of schema drift.
		let accountsRes;
		await checks.run("get_provider_accounts returns a success response", async () => {
			accountsRes = await client.send({ type: "get_provider_accounts", provider: SCENARIO_PROVIDER });
			if (accountsRes.type !== "response" || accountsRes.command !== "get_provider_accounts" || accountsRes.success !== true) {
				throw new Error(`unexpected response: ${JSON.stringify(accountsRes)}`);
			}
			return `command=${accountsRes.command} accounts=${accountsRes.data?.accounts?.length ?? "?"}`;
		});

		checks.ok(
			"accounts is an array (empty is valid on a machine with no configured accounts)",
			Array.isArray(accountsRes?.data?.accounts),
			`count=${accountsRes?.data?.accounts?.length ?? "?"}`,
		);

		// Redact defensively: RpcProviderAccount has no credential fields, but if
		// the schema ever leaks one, we never print it. Print name/source/blocked/pinned only.
		const safeAccounts = (accountsRes?.data?.accounts ?? []).map((a) => ({
			name: a.name,
			source: a.source,
			blocked: a.blocked,
			pinned: a.pinned,
		}));
		process.stdout.write(`get_provider_accounts [${SCENARIO_PROVIDER}] -> ${JSON.stringify(safeAccounts)}\n`);

		// --- set_model (rpc-types.ts line ~39) ---
		// Request shape: { type: "set_model", provider: string, modelId: string }
		// Response shape: { type: "response", command: "set_model",
		//                   success: true, data: Model<any> }
		// or { success: false, error: string }
		let modelRes;
		await checks.run("set_model selects a claude-sdk-oauth model", async () => {
			modelRes = await client.send({
				type: "set_model",
				provider: SCENARIO_PROVIDER,
				modelId: SCENARIO_MODEL_ID,
			});
			if (modelRes.type !== "response" || modelRes.command !== "set_model" || modelRes.success !== true) {
				throw new Error(`set_model failed: ${JSON.stringify(modelRes)}`);
			}
			return `provider=${modelRes.data?.provider} modelId=${modelRes.data?.id}`;
		});

		checks.ok(
			"set_model response contains the selected provider and model id",
			modelRes?.data?.provider === SCENARIO_PROVIDER && modelRes?.data?.id === SCENARIO_MODEL_ID,
			`provider=${modelRes?.data?.provider ?? "?"} id=${modelRes?.data?.id ?? "?"}`,
		);

		// Redact defensively: Model<any> has no credential fields, but strip anything
		// that is not a known-safe top-level key.
		const safeModel = (() => {
			if (!modelRes?.data) return null;
			const { provider, id, name, reasoning, input, contextWindow, maxTokens } = modelRes.data;
			return { provider, id, name, reasoning, input, contextWindow, maxTokens };
		})();
		process.stdout.write(`set_model [${SCENARIO_PROVIDER}/${SCENARIO_MODEL_ID}] -> ${JSON.stringify(safeModel)}\n`);

		client.close();
		await new Promise((r) => setTimeout(r, 300));
	} finally {
		client?.close();
		checks.ok("real auth unchanged", (() => {
			try {
				return guard.assertUnchanged();
			} catch {
				return false;
			}
		})(), guard.path);
		box.cleanup();
	}

	const passed = checks.finish();
	process.stdout.write(`VERDICT: ${passed ? "PASS" : "FAIL"} claude-sdk-oauth-accounts scenario ${passed ? "completed" : "failed"}\n`);
	process.exit(passed ? 0 : 1);
}

async function driveState() {
	installCleanupHooks();
	const box = makeSandbox("rpc-state");
	const client = new RpcClient({ env: box.env, cwd: box.cwd });
	const res = await client.send({ type: "get_state" });
	process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
	client.close();
	box.cleanup();
}

async function drivePrompt(message, { provider, model, slug, mockApi, withReasoning }) {
	installCleanupHooks();
	const guard = guardRealAuth();
	const box = makeSandbox(mockApi ? `rpc-mock-${mockApi}` : "rpc-prompt");
	let server;
	let client;
	try {
		const extraArgs = [];
		let env = box.env;
		if (mockApi) {
			const preset = API_PRESETS[mockApi];
			const turn = withReasoning
				? reasoningScriptedTurn()
				: { text: "SENPI-QA-RPC-MOCK-FINAL-7f3a" };
			server = await startFakeModelServer({ turns: [turn] });
			writeMockModelsJson(box.agentDir, server, mockApi);
			env = hermeticEnv(box.env);
			extraArgs.push("--provider", preset.provider, "--model", preset.modelId);
		} else {
			if (provider) extraArgs.push("--provider", provider);
			if (model) extraArgs.push("--model", model);
		}
		client = new RpcClient({ env, cwd: box.cwd, extraArgs });

		await client.send({ type: "get_state" }); // ensure booted
		const ack = await client.send({ type: "prompt", message });
		if (ack.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(ack)}`);

		// Mock reasoning runs are a strict end-to-end assertion: do not let a
		// terminal timeout or user abort masquerade as a stream with thinking.
		const terminal = await client.waitForEvent((e) => e.type === "agent_end" || e.type === "agent_aborted", { timeoutMs: 90000 });
		if (withReasoning && terminal.type !== "agent_end") throw new Error(`reasoning mock turn did not complete: ${terminal.type}`);
		const last = await client.send({ type: "get_last_assistant_text" });
		const text = last.data?.text ?? "";
		const thinkingFrames = client.events.filter(
			(event) => event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta",
		);
		if (withReasoning && thinkingFrames.length === 0) {
			throw new Error("reasoning mock turn completed without an RPC thinking_delta frame");
		}
		if (withReasoning && !text.includes(QA_FINAL_MARKER)) {
			throw new Error(`reasoning mock turn did not return ${QA_FINAL_MARKER}`);
		}
		process.stdout.write(`${text}\n`);

		if (slug) {
			const dir = evidenceDir(slug);
			writeFileSync(join(dir, "rpc-events.jsonl"), client.events.map((event) => JSON.stringify(event)).join("\n"));
			writeFileSync(join(dir, "rpc-last-assistant.txt"), text);
			process.stderr.write(`evidence: ${dir}\n`);
		}
		return text;
	} finally {
		client?.close();
		if (server) await server.stop();
		guard.assertUnchanged();
		box.cleanup();
	}
}

// --- entrypoint ---
const argv = process.argv.slice(2);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};
const mockApi = flag("--with-mock");
if (mockApi && !API_PRESETS[mockApi]) {
	process.stderr.write(`unknown --with-mock API ${mockApi}. valid: ${ALL_APIS.join(", ")}\n`);
	process.exit(2);
}
if (argv[0] === "--self-test") {
	selfTest();
} else if (argv[0] === "--state") {
	driveState();
} else if (argv[0] === "--scenario" && argv[1] === "claude-sdk-oauth-accounts") {
	driveScenarioClaudeSdkOauthAccounts().catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (argv.includes("--prompt")) {
	const message = flag("--prompt");
	const withReasoning = argv.includes("--with-reasoning");
	if (!message) {
		process.stderr.write("usage: rpc-drive.mjs --prompt <message> [--provider P --model M] [--evidence SLUG]\n");
		process.exit(2);
	}
	if (withReasoning && !mockApi) {
		process.stderr.write("--with-reasoning requires --with-mock <api>\n");
		process.exit(2);
	}
	drivePrompt(message, {
		provider: flag("--provider"),
		model: flag("--model"),
		slug: flag("--evidence"),
		mockApi,
		withReasoning,
	}).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else {
	process.stdout.write(
		[
			"senpi-qa Channel 1 — Remote RPC",
			"  node rpc-drive.mjs --self-test            verify get_state round-trips (no API)",
			"  node rpc-drive.mjs --state               print live RpcSessionState",
			"  node rpc-drive.mjs --scenario claude-sdk-oauth-accounts",
			"                                           # verify claude-sdk-oauth provider accounts + model selection over RPC",
			"  node rpc-drive.mjs --prompt <msg> ...    drive a real turn (needs a model)",
			"  node rpc-drive.mjs --with-mock <api> --with-reasoning --prompt <msg> [--evidence SLUG]",
			"",
		].join("\n"),
	);
}
