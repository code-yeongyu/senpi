import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startMultiSessionHost } from "../../scenarios/fused-equivalence/cases/support/multi-session-host.mjs";
import { cleanupAll, makeSandbox } from "./common.mjs";
import { startFakeModelServer } from "./fake-model-server.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "./mock-loop-support.mjs";

const MOCK = API_PRESETS["openai-completions"];

test.after(cleanupAll);

// The endpoint fence (senpi#4602) keeps durable lock files under `<tmpdir>/senpi-rpc-host-locks/`. The EQ host is
// throwaway, so nothing it writes may outlive the run in the job's temp root (the CI temp guard counts leftovers).
test("the EQ multi-session host leaves nothing in the temp root after its run stops", { timeout: 120_000 }, async () => {
	const previous = process.env.TMPDIR;
	const root = mkdtempSync(join(tmpdir(), "eqh-guard-"));
	process.env.TMPDIR = root;
	const box = makeSandbox("eqh-box");
	const server = await startFakeModelServer({ turns: [{ text: "unused" }] });
	try {
		writeMockModelsJson(box.agentDir, server, "openai-completions");
		const run = {
			args: ["--provider", MOCK.provider, "--model", MOCK.modelId, "--no-extensions", "--no-skills"],
			env: hermeticEnv(box.env),
			box,
			cleanups: [],
		};
		try {
			await startMultiSessionHost(run);
		} finally {
			for (const cleanup of run.cleanups.reverse()) await cleanup();
		}
		box.cleanup();
		assert.deepEqual(readdirSync(root), []);
	} finally {
		await server.stop();
		box.cleanup();
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
