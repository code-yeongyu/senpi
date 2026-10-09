import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs under Node, where the estimate cache keys on the exact JSON text. Under Bun (the runtime
// the CLI ships on) the key is a length plus a 128-bit digest; this runs that path in a real Bun process.
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!bunAvailable)("estimate cache key under Bun (senpi#2525)", () => {
	it("uses a digest key that still changes when same-length text changes", () => {
		const run = spawnSync("bun", [join(import.meta.dirname, "fixtures/estimate-cache-key-bun.ts")], {
			encoding: "utf8",
			cwd: join(import.meta.dirname, "../.."),
			// A blocking spawn ignores vitest's timeout; bound it so a stuck bun fails instead of hanging.
			timeout: 30_000,
		});
		expect(run.status, run.stderr).toBe(0);
		const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
		expect(result).toMatchObject({ runtime: "bun", keyIsText: false, sameLengthKeysDiffer: true });
		// The key must not hold a copy of the message text (review of senpi#2884).
		expect(result.keyLength).toBeLessThan(64);
	});
});
