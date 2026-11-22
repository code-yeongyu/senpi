import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const SHELL_SEES_NO_SENTINEL = ["booted", "status=0 sentinel=unset"];

// Under Bun, `delete process.env.X` does not reach the OS environment, so a child that inherits that environment
// still gets X. The host deletes its internal-key sentinel at boot; an agent shell that kept it made every senpi CLI
// started from that shell read a key from its unrelated stdin and exit internal_key_unavailable (senpi#5548).
describe.skipIf(!bunAvailable)("issue #5548 agent shells never carry the host's internal-key sentinel", () => {
	it("boots the CLI bootstrap from an agent shell's descendant after the host consumed its key", () => {
		// Given: a host child launched with the sentinel and a synthetic 32-byte key on stdin.
		const run = spawnSync("bun", [join(import.meta.dirname, "fixtures/issue-5548-agent-shell-sentinel.ts")], {
			env: { ...process.env, SENPI_RPC_INTERNAL_KEY_STDIN: "1" },
			input: Buffer.alloc(32, 7),
			encoding: "utf8",
			// A blocking spawn ignores vitest's timeout; bound it so a stuck bun fails instead of hanging.
			timeout: 90_000,
		});
		expect(run.status, run.stderr).toBe(0);

		// When: the host starts an agent shell on each terminal backend and that shell runs the bootstrap again.
		const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");

		// Then: the host consumed its sentinel, and no shell's descendant sees it or fails to boot.
		expect(result).toEqual({
			hostSentinel: null,
			shells: {
				native: SHELL_SEES_NO_SENTINEL,
				bun: SHELL_SEES_NO_SENTINEL,
				"pipe-fallback": SHELL_SEES_NO_SENTINEL,
			},
		});
	});
});
