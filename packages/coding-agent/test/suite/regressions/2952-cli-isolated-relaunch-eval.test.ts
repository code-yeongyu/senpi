import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL("../fixtures/2952-eval-parent.mjs", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx"));

// Regression: senpi#2952. The CLI entry, loaded from a `node -e` caller,
// must carry the caller's runtime options (loaders, memory flags, inspector)
// but never its entry mode into the isolated re-launch — for both the
// unbundled entry (dist/cli.js, sibling cli-main) and the bundled entry
// (the bundle re-executes itself, guarded by SENPI_CLI_ISOLATED_CHILD).
for (const kind of ["unbundled", "bundled"] as const) {
	it(`Given an eval caller when the ${kind} CLI entry re-launches isolated then the caller runs once`, async () => {
		const root = await mkdtemp(join(tmpdir(), "s2952-"));
		try {
			await execFileAsync(process.execPath, ["--import", loader, "-p", `import(${JSON.stringify(fixture)})`], {
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
					...(kind === "bundled" ? { SENPI_ARGV_REPRO_BUNDLED: "1" } : {}),
				},
			});
			const result = JSON.parse(await readFile(join(root, "result.json"), "utf8")) as {
				callerCount: number;
				receipt: { kind: string; execArgv: string[]; argv: string[]; isolatedChild: string | null };
				launchArgs: string[];
				launchError: string | null;
				childrenSettled: boolean;
			};
			expect(result.launchError).toBeNull();
			expect(result.callerCount).toBe(1);
			expect(result.receipt.kind).toBe("cli-entry");
			// The loader flag still reaches the child; the eval entry mode does not.
			expect(result.receipt.execArgv).toEqual(["--import", loader]);
			// Neither the eval code nor the eval caller path may reach the child.
			expect(result.launchArgs.join(" ")).not.toContain("2952-eval-parent");
			expect(result.receipt.argv.join(" ")).not.toContain("2952-eval-parent");
			expect(result.launchArgs).not.toContain("-e");
			expect(result.launchArgs).not.toContain("-p");
			// Both entries get the same recursion guard (senpi#2952).
			expect(result.receipt.isolatedChild).toBe("1");
			if (kind === "unbundled") {
				expect(result.launchArgs.some((arg) => arg.endsWith("cli-main.ts"))).toBe(true);
			} else {
				expect(result.launchArgs.some((arg) => arg.endsWith("cli.ts"))).toBe(true);
			}
			expect(result.childrenSettled).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 50_000);
}
