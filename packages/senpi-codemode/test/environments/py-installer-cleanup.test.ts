import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPipInstall } from "../../src/environments/py-installer.ts";
import { hasPythonWithPip } from "./wheel-fixtures.ts";

const scratchRm = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		rm: (path: Parameters<typeof original.rm>[0], options: Parameters<typeof original.rm>[1]) =>
			String(path).includes(".pip-") ? scratchRm(path, options) : original.rm(path, options),
	};
});
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	scratchRm.mockReset();
	vi.restoreAllMocks();
});

describe.skipIf(!hasPythonWithPip())("pip scratch cleanup errors", () => {
	for (const outcome of ["success", "failure", "cancel"] as const) {
		it(`preserves ${outcome} and reports exhausted cleanup retries (#3064)`, async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-pip-cleanup-proof-"));
			roots.push(root);
			const target = join(root, "target");
			await mkdir(target);
			await writeFile(
				join(root, "pip.py"),
				`
import sys, threading
print("STARTED", flush=True)
${outcome === "cancel" ? "threading.Event().wait()" : `sys.exit(${outcome === "failure" ? 3 : 0})`}
`,
			);
			scratchRm.mockRejectedValue(Object.assign(new Error("scratch is busy"), { code: "EBUSY" }));
			const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
			const controller = new AbortController();
			const pending = runPipInstall({
				interpreter: "python3",
				root: target,
				cwd: root,
				args: ["probe"],
				signal: controller.signal,
				onOutput: (stream, data) => {
					if (outcome === "cancel" && stream === "stdout" && data.includes("STARTED")) controller.abort();
				},
			});
			if (outcome === "success") await expect(pending).resolves.toBeUndefined();
			else
				await expect(pending).rejects.toMatchObject({
					code: outcome === "cancel" ? "environment_install_cancelled" : "environment_install_failed",
				});
			expect(scratchRm).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ recursive: true, force: true, maxRetries: 3 }),
			);
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("scratch is busy"), {
				code: "SENPI_PIP_SCRATCH_CLEANUP",
			});
		});
	}
});
