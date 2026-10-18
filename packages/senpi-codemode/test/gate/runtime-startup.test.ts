import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { runProcess } from "../../scripts/gate-process.ts";

it("removes its owned temporary root after a startup import fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-startup-"));
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	vi.stubEnv("TMPDIR", root);
	vi.stubEnv("TMP", root);
	vi.stubEnv("TEMP", root);
	try {
		const result = await runProcess(
			["bun", "scripts/gate-runtime.ts", join(root, "missing-target"), "js", "test/gate/helpers.golden.json"],
			packageRoot,
		);
		expect(result.exitCode).toBe(1);
		expect((await readdir(root)).filter((name) => name.startsWith("senpi-gate-runtime-"))).toEqual([]);
	} finally {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
}, 180_000);
