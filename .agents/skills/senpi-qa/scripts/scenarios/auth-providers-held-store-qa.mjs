#!/usr/bin/env node
// senpi-qa scenario for senpi#6841 over the real `--mode rpc` surface.
//
// Holds auth.json's proper-lockfile directory (kept fresh like a live holder in another process) and
// asks `get_auth_providers` WHILE it is held: the answer must come within the lock budget, read the
// stored credential as configured and say the store is busy. After the lock clears, the next answer
// must read it as configured with no busy flag.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/auth-providers-held-store-qa.mjs --self-test
//   node .agents/skills/senpi-qa/scripts/scenarios/auth-providers-held-store-qa.mjs --self-test --evidence auth-providers-held-store
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox } from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { RpcClient } from "../lib/rpc-client.mjs";

const PROVIDER = "openai";
const BUSY_MARKER = "Credential store is busy";
const BUSY_WAIT_MS = 120000;
const HELD_ANSWER_BUDGET_MS = 5000;
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
	const box = makeSandbox("auth-providers-held-store");
	const authPath = join(box.agentDir, "auth.json");
	const lockPath = `${authPath}.lock`;
	writeFileSync(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: "sk-qa-6841" } }));
	mkdirSync(lockPath);
	// A live proper-lockfile holder refreshes the lock's mtime; without that the lock goes stale
	// after 30 s and the CLI takes it over.
	const keepAlive = setInterval(() => {
		const now = new Date();
		if (existsSync(lockPath)) utimesSync(lockPath, now, now);
	}, 2000);

	const checks = createChecks("#6841 get_auth_providers while another process holds auth.json's lock (RPC)");
	const env = hermeticEnv(box.env);
	for (const name of Object.keys(env)) if (name.endsWith("_CODING_AGENT_DIR")) env[name] = box.agentDir;
	delete env.SENPI_BRAND;
	const rpc = new RpcClient({ env, cwd: box.cwd });
	const transcript = [];
	try {
		const sawBusy = await waitForStderr(rpc, BUSY_MARKER, BUSY_WAIT_MS);
		transcript.push({ step: "startup credential read reported busy", sawBusy });
		checks.ok("the startup credential read found the store busy", sawBusy);

		const timed = async (command) => {
			const started = Date.now();
			const response = await rpc.send(command, { timeoutMs: 90000 });
			return { response, ms: Date.now() - started };
		};
		const state = await timed({ type: "get_state" });
		const first = await timed({ type: "get_auth_providers" });
		const { response: held, ms: heldMs } = await timed({ type: "get_auth_providers" });
		transcript.push({ step: "timings while the lock is held", getStateMs: state.ms, firstAuthMs: first.ms, secondAuthMs: heldMs });
		transcript.push({ step: "auth while the lock is held", heldMs, status: apiKeyStatus(held), storeBusy: held?.data?.storeBusy ?? null });
		checks.ok(`while the lock is held, the answer comes within ${HELD_ANSWER_BUDGET_MS} ms`, heldMs < HELD_ANSWER_BUDGET_MS, `${heldMs} ms`);
		checks.ok(
			"while the lock is held, the stored credential reads as configured and the store as busy",
			apiKeyStatus(held)?.configured === true && held?.data?.storeBusy === true,
			JSON.stringify({ status: apiKeyStatus(held), storeBusy: held?.data?.storeBusy ?? null }),
		);

		clearInterval(keepAlive);
		rmSync(lockPath, { recursive: true, force: true });
		const after = await rpc.send({ type: "get_auth_providers" }, { timeoutMs: 45000 });
		transcript.push({ step: "auth after the lock clears", status: apiKeyStatus(after), storeBusy: after?.data?.storeBusy ?? null });
		checks.ok(
			"after the lock clears, the stored credential reads as configured with no busy flag",
			apiKeyStatus(after)?.configured === true && after?.data?.storeBusy === undefined,
			JSON.stringify({ status: apiKeyStatus(after), storeBusy: after?.data?.storeBusy ?? null }),
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
