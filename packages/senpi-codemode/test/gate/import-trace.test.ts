import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../scripts/gate-process.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("missing import observations", () => {
	it.each(["empty", "missing"])(
		"reports an unwitnessed worker for a %s trace",
		async (trace) => {
			const root = await mkdtemp(join(tmpdir(), "senpi-census-trace-"));
			try {
				const target = join(root, "packages/senpi-codemode");
				for (const directory of ["extension", "config", "interpreters"])
					await mkdir(join(target, "src", directory), { recursive: true });
				await writeFile(join(root, "package.json"), '{"type":"module"}');
				await writeFile(join(target, "src/index.ts"), "export const fixture = true;");
				await writeFile(join(target, "src/config/settings.ts"), "export const defaultCodemodeSettings = {};");
				await writeFile(
					join(target, "src/interpreters/detect.ts"),
					"export const createInterpreterDetector = () => ({}); export const getInterpreterAvailability = async () => ({});",
				);
				await writeFile(
					join(target, "src/extension/session-manager.ts"),
					`
import { rmSync, writeFileSync } from "node:fs";
export async function createCodemodeSessionManager() {
	return {
		getKernel: async () => ({ run: async () => ({ ok: true }) }),
		dispose: async () => {
			const path = process.env.SENPI_GATE_IMPORT_FILE;
			${trace === "empty" ? 'writeFileSync(path, "");' : "rmSync(path, { force: true });"}
		},
	};
}`,
				);
				const result = await runProcess(
					["node", "--import", "tsx", join(packageRoot, "scripts/gate-imports.ts"), target],
					packageRoot,
				);
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain("import observer did not witness the kernel worker");
				expect(result.stderr).not.toContain("SyntaxError");
				expect(result.stderr).not.toContain("ENOENT");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		180_000,
	);
});
