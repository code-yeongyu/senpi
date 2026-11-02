import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const hostEnsureSource = new URL("../src/modes/rpc/host-ensure.ts", import.meta.url);

describe("ensureHost lock scope", () => {
	it("#given the ensureHost body #when the endpoint lock is taken #then the tmpdir reap is ordered before acquisition", async () => {
		const source = await readFile(hostEnsureSource, "utf8");
		const body = source.slice(source.indexOf("export async function ensureHost("));
		const reapAt = body.indexOf("reapOrphanedInternalHostDirs()");
		const acquireAt = body.indexOf("acquireOwnershipSafeLock(");

		expect(reapAt).toBeGreaterThan(-1);
		expect(acquireAt).toBeGreaterThan(-1);
		// Reaping inside the critical section made lock hold time scale with the whole
		// tmpdir and, on win32, with a ~1s process probe per candidate, until a concurrent
		// ensureHost exhausted its lock budget and surfaced a raw "database is locked".
		expect(reapAt).toBeLessThan(acquireAt);
	});
});
