#!/usr/bin/env node
/**
 * PR #875: real source RPC compaction compatibility and restart recovery.
 * Successful builtin compactions must remain uncapped on current main. A
 * legacy extension may still report per-turn-cap; required admission must
 * retain its recovery feedback without issuing a doomed provider request.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, repoRoot } from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const FORMER_ABSOLUTE_CAP = 10;
const FINAL_MARKER = "PR875-RECOVERED";

async function prompt(client, message) {
	// Subscribe before the command; no sleeps or event polling.
	const terminal = client.waitFor(({ message: event }) => event.type === "agent_end");
	const response = await client.send({ type: "prompt", message });
	assert.equal(response.success, true, JSON.stringify(response));
	await terminal;
	const result = await client.send({ type: "get_last_assistant_text" });
	assert.equal(result.data.text, FINAL_MARKER);
}

async function main() {
	if (!process.argv.includes("--self-test")) {
		throw new Error("Use --self-test [--evidence SLUG]");
	}
	installCleanupHooks();
	const evidenceFlag = process.argv.indexOf("--evidence");
	const evidence = evidenceDir(evidenceFlag < 0 ? "compaction-absolute-cap" : process.argv[evidenceFlag + 1]);
	const guard = guardRealAuth();
	const box = makeSandbox("pr875-compaction-recovery");
	const observed = { acceptedCompactions: 0, legacyRejection: null, requiredRejection: null, recovered: false };
	let server;
	let client;
	try {
		server = await startFakeModelServer({ turns: [{ text: FINAL_MARKER }] });
		writeMockModelsJson(box.agentDir, server, "anthropic-messages");
		const settings = {
			compaction: { keepRecentTokens: 40, idleCompactionEnabled: false },
			retry: { enabled: false },
			experimental: { sharedHost: false },
		};
		writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify(settings));
		const env = hermeticEnv(box.env);
		// Restrict ambient discovery/credentials to the sandbox even for less common providers.
		for (const name of Object.keys(env)) {
			if (/(?:API_KEY|TOKEN|SECRET|CREDENTIAL|AUTH|BASE_URL)/i.test(name)) delete env[name];
		}
		const options = { env, cwd: box.cwd, targetRoot: repoRoot() };
		const modelArgs = ["--provider", "anthropic", "--model", "mock-claude", "--no-tools"];
		client = new TargetRpcClient({ ...options, extraArgs: modelArgs });
		await prompt(client, "seed ".repeat(1_000));
		await prompt(client, "retained turn ".repeat(1_000));
		for (let round = 0; round <= FORMER_ABSOLUTE_CAP; round++) {
			const result = await client.send({ type: "compact" });
			assert.equal(result.success, true, JSON.stringify(result));
			observed.acceptedCompactions++;
			await prompt(client, "filler " + round + ": " + "context ".repeat(500));
		}
		assert.equal(observed.acceptedCompactions, FORMER_ABSOLUTE_CAP + 1);
		const state = await client.send({ type: "get_state" });
		const sessionFile = state.data.sessionFile;
		assert.equal(typeof sessionFile, "string");
		const sessionId = state.data.sessionId;
		await client.close();
		client = undefined;

		// Legacy policy is injected only here, never reintroduced into the builtin.
		writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify({
			...settings, disabledBuiltinExtensions: ["compaction"],
		}));
		const extension = join(box.dir, "legacy-cap.mjs");
		writeFileSync(extension, 'export default function(pi) { pi.on("session_before_compact", () => ({ cancel: true, rejectionCause: "per-turn-cap" })); }');
		client = new TargetRpcClient({
			...options,
			extraArgs: [...modelArgs, "--session", sessionFile, "--no-extensions", "--extension", extension],
		});
		const manual = await client.send({ type: "compact" });
		assert.equal(manual.success, false);
		assert.equal(typeof manual.error, "string");
		observed.legacyRejection = manual.error;
		// Seed a recorded provider overflow through the public session-entry RPC seam.
		const entries = await client.send({ type: "get_entries" });
		const appended = await client.send({
			type: "append_session_entry",
			entry: {
				type: "message", id: randomUUID(), parentId: entries.data.leafId,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "mock-claude",
					stopReason: "error", errorMessage: "context_length_exceeded", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				},
			},
		});
		assert.equal(appended.success, true);
		const callsBeforeAdmission = server.requests.length;
		const rejection = client.waitFor(({ message: event }) =>
			event.type === "compaction_end" && event.rejectionCause === "per-turn-cap");
		const rejected = await client.send({ type: "prompt", message: "recover this session" });
		await rejection;
		assert.equal(rejected.success, false);
		assert.equal(typeof rejected.error, "string");
		// Shipped-copy equality across real RPC error channels, not a prose pin.
		assert.ok(rejected.error.includes(manual.error));
		assert.equal(server.requests.length, callsBeforeAdmission);
		observed.requiredRejection = rejected.error;
		observed.providerCallsDuringRejectedAdmission = server.requests.length - callsBeforeAdmission;
		await client.close();
		client = undefined;

		// Restart the real CLI on the same persisted session, with current builtin policy.
		writeFileSync(join(box.agentDir, "settings.json"), JSON.stringify(settings));
		client = new TargetRpcClient({ ...options, extraArgs: [...modelArgs, "--session", sessionFile] });
		const resumed = await client.send({ type: "get_state" });
		assert.equal(resumed.data.sessionId, sessionId);
		await prompt(client, "resume after restarting the CLI");
		observed.recovered = true;
		observed.providerCallsAfterRestart = server.requests.length - callsBeforeAdmission;
		assert.ok(observed.providerCallsAfterRestart > 0);
		const renewed = await client.send({ type: "new_session" });
		assert.equal(renewed.success, true);
		await prompt(client, "new-session recovery");
		observed.newSessionRecovered = true;
		console.log("PASS: 11 builtin compactions; legacy cap feedback; zero blocked provider calls; same-session restart and new-session recovery");
	} finally {
		observed.finalCompactions = client?.events.filter(({ message }) => message.type === "compaction_end")
			.map(({ message }) => ({ accepted: message.accepted, rejectionCause: message.rejectionCause, errorMessage: message.errorMessage }));
		await client?.close();
		await server?.stop();
		guard.assertUnchanged();
		observed.authUnchanged = true;
		writeFileSync(join(evidence, "observed.json"), JSON.stringify(observed, null, 2) + "\n");
		box.cleanup();
	}
}

await main();
