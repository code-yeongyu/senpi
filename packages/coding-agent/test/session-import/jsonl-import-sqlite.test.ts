import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// The package's default Vitest host is Node until S21b; exercise the native backend in a Bun child on both hosts.
it("reopens imported tails and a hatch fork from a real Bun SQLite store", async () => {
	const result = await promisify(execFile)(
		"bun",
		[fileURLToPath(new URL("./fixtures/sqlite-reopen.ts", import.meta.url))],
		{ cwd: fileURLToPath(new URL("../../../../", import.meta.url)), timeout: 20_000 },
	);
	expect(result.stderr).toBe("");
}, 30_000);
