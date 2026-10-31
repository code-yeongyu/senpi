import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quarantineAgentDirEnv } from "./test-agent-dir.mjs";

test("quarantineAgentDirEnv replaces every inherited agent-dir lane with the run's own dir", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-dir-quarantine-"));
	try {
		const inherited = {
			OMO_CODING_AGENT_DIR: "/home/user/.omo/agent",
			SENPI_CODING_AGENT_DIR: "/home/user/.omo/agent",
			PI_CODING_AGENT_DIR: "/home/user/.pi/agent",
			UNRELATED: "keep",
		};

		const next = quarantineAgentDirEnv(inherited, root);

		assert.deepEqual(next, { UNRELATED: "keep", SENPI_CODING_AGENT_DIR: join(root, "agent"), SENPI_TEST_AGENT_DIR_GUARD: "1" });
		assert.ok(existsSync(join(root, "agent")));
		assert.equal(inherited.OMO_CODING_AGENT_DIR, "/home/user/.omo/agent");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("importing the shared vitest.base.ts leaves the agent dir alone (evals read the real one)", () => {
	const repoRoot = new URL("..", import.meta.url).pathname;
	const probe = spawnSync(
		"bun",
		["-e", 'await import("./vitest.base.ts"); process.stdout.write(process.env.SENPI_CODING_AGENT_DIR ?? "");'],
		{ cwd: repoRoot, env: { ...process.env, SENPI_CODING_AGENT_DIR: "/home/user/.senpi/agent", SENPI_TEST_AGENT_DIR_GUARD: "" }, encoding: "utf8" },
	);

	assert.equal(probe.status, 0, probe.stderr);
	assert.equal(probe.stdout, "/home/user/.senpi/agent");
});

test("a copy of vitest.base.ts alone resolves, as the evals Docker image ships it", () => {
	const repoRoot = new URL("..", import.meta.url).pathname;
	const image = mkdtempSync(join(tmpdir(), "evals-image-"));
	try {
		copyFileSync(join(repoRoot, "vitest.base.ts"), join(image, "vitest.base.ts"));
		symlinkSync(join(repoRoot, "node_modules"), join(image, "node_modules"), "dir");
		const probe = spawnSync("bun", ["-e", 'await import("./vitest.base.ts"); process.stdout.write("RESOLVED");'], {
			cwd: image,
			encoding: "utf8",
		});

		assert.equal(probe.status, 0, probe.stderr);
		assert.equal(probe.stdout, "RESOLVED");
	} finally {
		rmSync(image, { recursive: true, force: true });
	}
});

test("quarantineAgentDirEnv leaves the env alone under SENPI_TEST_USE_REAL_AGENT_DIR=1", () => {
	const inherited = { SENPI_TEST_USE_REAL_AGENT_DIR: "1", SENPI_CODING_AGENT_DIR: "/home/user/.senpi/agent" };

	assert.equal(quarantineAgentDirEnv(inherited, "/unused"), inherited);
});
