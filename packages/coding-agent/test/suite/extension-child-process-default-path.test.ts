// senpi#3566 todo 4 (review HIGH 1): with the child runtime off - the default - an extension loaded by the session's
// loader gets the real node:child_process (named import, default import, require), byte-for-byte as before.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const probe = resolve(import.meta.dirname, "../fixtures/loader-child-process-probe.ts");
const bunAvailable = spawnSync("bun", ["--version"]).status === 0;

describe.skipIf(!bunAvailable)("extension child_process on the default path", () => {
	it("is the real builtin in every import form, promisify(exec) resolves { stdout, stderr }, and packages named after Object.prototype keys load", () => {
		const run = spawnSync("bun", [probe], { encoding: "utf8", timeout: 60_000 });
		expect(run.status, run.stderr).toBe(0);
		expect(JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
			loadErrors: [],
			defaultIsReal: true,
			namedExecIsReal: true,
			requiredIsReal: true,
			requiredBareIsReal: true,
			promised: { stdout: "hi\n", stderr: "" },
			prototypeNamedPackages: [42, 42],
		});
	}, 90_000);
});
