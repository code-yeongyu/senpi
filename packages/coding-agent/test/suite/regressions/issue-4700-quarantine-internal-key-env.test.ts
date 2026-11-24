import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scrubHostLifecycleEnv } from "../../support/quarantine.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

describe("issue #4700 internal key environment quarantine", () => {
	it("removes current and future internal key variables without removing unrelated RPC settings", () => {
		// Given: inherited bootstrap state, including future names in the internal-key namespace.
		const env = {
			SENPI_RPC_INTERNAL_KEY_STDIN: "1",
			SENPI_RPC_INTERNAL_KEY: "synthetic",
			SENPI_RPC_INTERNAL_KEY_FUTURE: "synthetic",
			SENPI_RPC_SESSION_IDLE_EVICTION_MS: "keep",
		};

		// When: test setup quarantines the inherited host environment.
		scrubHostLifecycleEnv(env);

		// Then: no internal-key state can be inherited by a child.
		expect(env).toEqual({ SENPI_RPC_SESSION_IDLE_EVICTION_MS: "keep" });
	});

	it("starts a CLI child without trying to read an inherited internal key from stdin", () => {
		// Given: the runner was launched inside an RPC host child.
		const env = { ...process.env, SENPI_RPC_INTERNAL_KEY_STDIN: "1" };

		// When: a CLI is spawned after quarantine, with no key on stdin.
		scrubHostLifecycleEnv(env);
		const child = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("../../../src/cli-main.ts", import.meta.url)), "--version"],
			{ env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);

		// Then: bootstrap does not abort the CLI.
		expect(child.error).toBeUndefined();
		expect(child.stderr).not.toContain("internal_key_unavailable");
		expect(child.status).toBe(0);
		expect(child.stdout.trim()).not.toBe("");
	});
});
