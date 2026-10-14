#!/usr/bin/env node
// senpi-qa scenario for omo-desktop-app #2249 over the real `--mode rpc` surface.
//
// Holds auth.json's proper-lockfile directory (kept fresh like a live holder) until the
// CLI's startup credential read reports the store busy, releases it, then asks
// `get_auth_providers` before any availability pass, and once more after one. The stored
// credential must read as configured both times, matching the models that work.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/auth-status-busy-store-qa.mjs --self-test
//   node .agents/skills/senpi-qa/scripts/scenarios/auth-status-busy-store-qa.mjs --self-test --evidence auth-status-busy-store
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox } from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { RpcClient } from "../lib/rpc-client.mjs";

const PROVIDER = "openai";
const BUSY_MARKER = "Credential store is busy";
const BUSY_WAIT_MS = 120000;
const argv = process.argv.slice(2);
const evidenceSlug = argv.includes("--evidence") ? argv[argv.indexOf("--evidence") + 1] : undefined;

const apiKeyStatus = (response) =>
	(response?.data?.providers ?? []).find((row) => row.id === PROVIDER && row.authType === "api_key")?.status ?? null;

function waitForStderr(rpc, marker, timeoutMs) {
	if (rpc.stderr.includes(marker)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			rpc.child.stderr.off("data", onData);
			resolve(false);
		}, timeoutMs);
		const onData = () => {
			if (!rpc.stderr.includes(marker)) return;
			clearTimeout(timer);
			rpc.child.stderr.off("data", onData);
			resolve(true);
		};
		rpc.child.stderr.on("data", onData);
	});
}

async function main() {
	installCleanupHooks();
	const realAuth = guardRealAuth();
	const box = makeSandbox("auth-status-busy-store");
	const authPath = join(box.agentDir, "auth.json");
	const lockPath = `${authPath}.lock`;
	writeFileSync(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: "sk-qa-2249" } }));
	mkdirSync(lockPath);
	// A live proper-lockfile holder refreshes the lock's mtime; without that a slow CLI start
	// outlives the 30 s stale window and the lock is taken over as stale.
	const keepAlive = setInterval(() => {
		const now = new Date();
		if (existsSync(lockPath)) utimesSync(lockPath, now, now);
	}, 2000);

	const checks = createChecks("#2249 auth status after a busy first credential read (RPC)");
	const env = hermeticEnv(box.env);
	for (const name of Object.keys(env)) if (name.endsWith("_CODING_AGENT_DIR")) env[name] = box.agentDir;
	delete env.SENPI_BRAND;
	const rpc = new RpcClient({ env, cwd: box.cwd });
	const transcript = [];
	try {
		const sawBusy = await waitForStderr(rpc, BUSY_MARKER, BUSY_WAIT_MS);
		transcript.push({ step: "startup credential read reported busy", sawBusy });
		checks.ok("the startup credential read found the store busy", sawBusy);
		clearInterval(keepAlive);
		rmSync(lockPath, { recursive: true, force: true });

		const beforePass = await rpc.send({ type: "get_auth_providers" }, { timeoutMs: 45000 });
		transcript.push({ step: "auth after release, before any availability pass", status: apiKeyStatus(beforePass) });
		checks.ok(
			"after the lock clears, the stored credential reads as configured before any availability pass",
			apiKeyStatus(beforePass)?.configured === true,
			JSON.stringify(apiKeyStatus(beforePass)),
		);

		const models = await rpc.send({ type: "get_available_models" }, { timeoutMs: 90000 });
		const modelCount = (models?.data?.models ?? []).filter((model) => model.provider === PROVIDER).length;
		const afterPass = await rpc.send({ type: "get_auth_providers" }, { timeoutMs: 45000 });
		transcript.push({ step: "after an availability pass", modelCount, status: apiKeyStatus(afterPass) });
		checks.ok(
			"after an availability pass, the stored credential still reads as configured",
			apiKeyStatus(afterPass)?.configured === true,
			`${modelCount} models; ${JSON.stringify(apiKeyStatus(afterPass))}`,
		);
	} finally {
		clearInterval(keepAlive);
		rpc.child?.kill?.();
		rmSync(lockPath, { recursive: true, force: true });
		box.cleanup();
	}
	await checks.run("real auth.json unchanged", async () => realAuth.assertUnchanged() && "sha256 unchanged");

	if (evidenceSlug) {
		writeFileSync(join(evidenceDir(evidenceSlug), "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`);
	}
	process.exitCode = checks.finish() ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
