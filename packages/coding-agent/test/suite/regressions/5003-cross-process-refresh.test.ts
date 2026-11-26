import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./5003-refresh-process-fixture.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../../../..", import.meta.url));

// #5003: two real Bun processes share auth.json and an IPC-only fake endpoint
// that rejects reuse. The endpoint and stale-read barriers, not sleeps, order
// the race. RuntimeCredentials is included so dropping the capability fails.
describe("rotating refresh tokens across processes", () => {
	it.each([
		["a", "a", false],
		["flat", "a", false],
		["a", "catalog", false],
		["flat", "flat", false],
		["identity-flat", "a", false],
		["a", "b", false],
		["a", "a", true],
		["flat", "a", true],
	])(
		"serializes one session but not siblings (%s/%s, no identity: %s)",
		async (first, second, noIdentity) => {
			const { stdout } = await run(
				"bun",
				[
					"--tsconfig-override",
					`${root}/tsconfig.json`,
					fixture,
					first,
					second,
					`${root}/tsconfig.json`,
					String(noIdentity),
				],
				{
					cwd: root,
					env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
					timeout: 40_000,
				},
			);
			expect(stdout).toContain(`PASS ${first}/${second}`);
		},
		45_000,
	);
});
