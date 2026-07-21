import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { cleanupAllAndWait, trackChild } from "./cleanup.mjs";

const fixturePath = fileURLToPath(new URL("./cleanup-fixture.mjs", import.meta.url));

test.skipIf(process.platform === "win32")(
	"cleanupAllAndWait removes the owned process group when its leader exits before a SIGTERM-resistant child",
	async () => {
		// Given: a detached leader and same-group leaf with opposite SIGTERM behavior.
		const leader = spawn(process.execPath, [fixturePath, "leader"], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const processGroupId = leader.pid;
		assert.notEqual(processGroupId, undefined, "fixture leader did not expose a PID");
		trackChild(leader);

		try {
			const ready = await fixtureReady(leader);
			assert.equal(ready.leaderPid, processGroupId);

			// When: cleanup TERM-signals the group and the leader exits first.
			await cleanupAllAndWait(500);

			// Then: cleanup must not return while the resistant same-group leaf survives.
			assert.equal(
				processGroupIsAlive(processGroupId),
				false,
				`cleanup returned with process group ${processGroupId} still alive (leaf ${ready.leafPid})`,
			);
		} finally {
			killExactProcessGroup(processGroupId);
			const closed = await waitForProcessGroupExit(processGroupId, 1000);
			await cleanupAllAndWait(1000);
			if (!closed) throw new Error(`fixture process group ${processGroupId} survived exact-PGID SIGKILL cleanup`);
		}
	},
);

function fixtureReady(child) {
	return new Promise((resolveReady, rejectReady) => {
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			const newline = stdout.indexOf("\n");
			if (newline === -1) return;
			resolveReady(JSON.parse(stdout.slice(0, newline)));
		});
		child.once("error", rejectReady);
		child.once("exit", (code, signal) => {
			rejectReady(new Error(`fixture leader exited before readiness: code=${code} signal=${signal} stderr=${stderr}`));
		});
	});
}

function processGroupIsAlive(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
		throw error;
	}
}

function killExactProcessGroup(processGroupId) {
	try {
		process.kill(-processGroupId, "SIGKILL");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
	}
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (processGroupIsAlive(processGroupId) && Date.now() < deadline) {
		await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
	}
	return !processGroupIsAlive(processGroupId);
}
