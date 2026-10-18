import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	cleanupAllAndWait,
	hermeticEnv,
	makeScratch,
	packageDir,
	repoRoot,
	startFakeModelServer,
} from "./env.mjs";

test("neutral QA helpers retain package roots and hermetic environment", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	assert.equal(packageDir, resolve(here, "../../.."));
	assert.equal(repoRoot, resolve(packageDir, "../.."));
	const inherited = { PATH: "/synthetic/bin", OPENAI_API_KEY: "not-a-real-key", PI_OFFLINE: "1" };
	assert.deepEqual(hermeticEnv(inherited), { PATH: "/synthetic/bin", PI_OFFLINE: "1" });
	assert.equal(inherited.OPENAI_API_KEY, "not-a-real-key");
});

test("neutral QA cleanup owns scratch directories", async () => {
	const scratch = makeScratch("shared-qa-ownership");
	try {
		assert.equal(existsSync(scratch.cwd), true);
		assert.equal(scratch.env.SENPI_CODING_AGENT_DIR, scratch.agentDir);
		await cleanupAllAndWait();
		assert.equal(existsSync(scratch.dir), false);
	} finally {
		scratch.cleanup();
	}
});

test("neutral model fixture serves streaming completion requests", async () => {
	const fake = await startFakeModelServer([{ text: "shared-helper-ok" }]);
	try {
		const response = await fetch(`${fake.url}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "mock-model", messages: [], stream: true }),
			signal: AbortSignal.timeout(5000),
		});
		assert.equal(response.status, 200);
		assert.match(await response.text(), /shared-helper-ok/);
		assert.equal(fake.requests.length, 1);
		assert.equal(fake.requests[0].model, "mock-model");
	} finally {
		await fake.stop();
	}
}, 10000);
