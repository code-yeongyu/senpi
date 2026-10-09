import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL("../fixtures/2599-eval-parent.mjs", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx"));

// Regression: senpi#2599. These are the three issue-listed launchers reachable from a Node eval caller.
for (const kind of ["daemon", "schedule", "update"] as const) {
	it(`Given an eval caller when ${kind} starts a script child then the caller runs once`, async () => {
		const root = await mkdtemp(join(tmpdir(), "s2599-"));
		try {
			await execFileAsync(
				process.execPath,
				["--import", loader, "-p", `import(${JSON.stringify(pathToFileURL(fixture).href)})`],
				{
					cwd: root,
					timeout: 45_000,
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
						TMPDIR: process.env.TMPDIR,
						HOME: root,
						USERPROFILE: root,
						SENPI_CODING_AGENT_DIR: join(root, "agent"),
						SENPI_RUNTIME: "node",
						PI_OFFLINE: "1",
						SENPI_ARGV_REPRO_ROOT: root,
						SENPI_ARGV_REPRO_CASE: kind,
					},
				},
			);
			const result = JSON.parse(await readFile(join(root, "result.json"), "utf8")) as {
				callerCount: number;
				receipt: { kind: string; execArgv: string[]; argv: string[] };
				launchError: string | null;
				childrenSettled: boolean;
			};
			expect(result.callerCount).toBe(1);
			expect(result.receipt.kind).toBe("target-entry");
			expect(result.receipt.execArgv).toEqual(["--import", loader]);
			expect(result.launchError).toBeNull();
			expect(result.childrenSettled).toBe(true);
			expect(result.receipt.argv).toContain(
				kind === "daemon" ? "app-server" : kind === "update" ? "update" : "--session",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 50_000);
}
