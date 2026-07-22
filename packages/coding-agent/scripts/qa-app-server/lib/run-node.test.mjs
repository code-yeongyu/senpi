import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { terminateScenario } from "./run-node.mjs";

const fixturePath = fileURLToPath(new URL("./run-node-fixture.mjs", import.meta.url));

test("terminateScenario allows cooperative SIGTERM cleanup before returning", async () => {
	// Given: a scenario that records SIGTERM and exits cooperatively.
	const fixture = await spawnReadyFixture("cooperative");

	try {
		// When: the timeout terminator stops the scenario.
		await terminateScenario(fixture.child, 200);
		const result = await fixture.closed;

		// Then: the scenario observed TERM and exited without forced killing.
		assert.equal(fixture.termReceived, true, "timeout termination skipped SIGTERM cleanup and killed the scenario directly");
		assert.deepEqual(result, { code: 0, signal: null });
	} finally {
		await killExactFixture(fixture);
	}
});

test("terminateScenario SIGKILLs a SIGTERM-resistant scenario after the grace budget", async () => {
	// Given: a scenario that observes SIGTERM but deliberately remains alive.
	const fixture = await spawnReadyFixture("resistant");

	try {
		// When: the graceful timeout budget expires.
		await terminateScenario(fixture.child, 100);
		const result = await fixture.closed;

		// Then: TERM was offered before the bounded SIGKILL fallback closed the process.
		assert.equal(fixture.termReceived, true, "timeout fallback killed the resistant scenario before SIGTERM cleanup ran");
		assert.deepEqual(result, { code: null, signal: "SIGKILL" });
	} finally {
		await killExactFixture(fixture);
	}
});

async function spawnReadyFixture(mode) {
	const child = spawn(process.execPath, [fixturePath, mode], {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	const fixture = {
		child,
		closed: childResult(child),
		termReceived: false,
	};
	child.on("message", (message) => {
		if (message?.type === "term") fixture.termReceived = true;
	});
	await waitForMessage(child, "ready");
	return fixture;
}

function waitForMessage(child, type) {
	return new Promise((resolveMessage, rejectMessage) => {
		const onMessage = (message) => {
			if (message?.type !== type) return;
			child.off("error", rejectMessage);
			resolveMessage();
		};
		child.on("message", onMessage);
		child.once("error", rejectMessage);
	});
}

function childResult(child) {
	return new Promise((resolveResult, rejectResult) => {
		child.once("close", (code, signal) => resolveResult({ code, signal }));
		child.once("error", rejectResult);
	});
}

async function killExactFixture(fixture) {
	if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL");
	await fixture.closed;
}
