#!/usr/bin/env node
/**
 * Live delivery probe for the claude-sdk-oauth lane's inline auto-compaction setting.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-autocompact-settings-probe.mjs
 *
 * The sandbox must contain an OAuth credential in auth.json using the same slots
 * as the other claude-sdk-oauth spikes. Never prints token material.
 */
import {
	closeQuietly,
	loadCredential,
	managedEnvironment,
	reject,
	requireLiveGate,
	requireSandbox,
	startGuardedQuery,
	withTimeout,
} from "./lib/claude-sdk-oauth-spike-support.mjs";

requireLiveGate();
const sandbox = requireSandbox();
const loaded = loadCredential(sandbox);
if (loaded.error) reject(loaded.error);

const { input, stream, disarm } = await startGuardedQuery({
	firstMessage: undefined,
	options: {
		model: "claude-haiku-4-5",
		tools: [],
		permissionMode: "dontAsk",
		settingSources: [],
		settings: { autoCompactEnabled: true },
		env: managedEnvironment(loaded.credential.access, { CLAUDE_CONFIG_DIR: sandbox }),
	},
	secrets: [loaded.credential.access],
});

let usage;
let outcome;
try {
	usage = await withTimeout(stream.getContextUsage(), "context_usage", 60_000);
} catch (error) {
	outcome = error instanceof Error ? error.message : String(error);
} finally {
	input.close();
	closeQuietly(stream);
	disarm();
}

if (outcome) reject(outcome, "", [loaded.credential.access]);
console.log(`isAutoCompactEnabled=${usage.isAutoCompactEnabled}`);
if (usage.isAutoCompactEnabled !== true) reject("autocompact_setting_not_delivered");
