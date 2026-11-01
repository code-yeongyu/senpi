import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL("../fixtures/2952-eval-cli-parent.mjs", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx"));
const entries = {
	unbundled: fileURLToPath(new URL("../../../dist/cli.js", import.meta.url)),
	bundled: fileURLToPath(new URL("../../../dist/bundle/cli.js", import.meta.url)),
};

// Regression: senpi#2952. The isolated re-launch keeps the caller's runtime options but never its eval entry mode.
for (const [kind, entry] of Object.entries(entries)) {
	it(`Given an eval caller when the ${kind} CLI entry re-launches itself then the caller runs once`, async () => {
		expect(existsSync(entry), `${entry} is missing; build the coding-agent package first`).toBe(true);
		const root = await mkdtemp(join(tmpdir(), "s2952-"));
		try {
			const exitCode = await execFileAsync(
				process.execPath,
				[
					"--import",
					loader,
					"--max-old-space-size=4096",
					"-p",
					`import(${JSON.stringify(pathToFileURL(fixture).href)})`,
				],
				{
					cwd: root,
					timeout: 90_000,
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
						SENPI_ARGV_REPRO_CLI_ENTRY: entry,
					},
				},
			).then(
				() => 0,
				(error: { code?: number | string }) => error.code,
			);
			const result = JSON.parse(await readFile(join(root, "result.json"), "utf8")) as {
				callerCount: number;
				receipt: { kind: string; execArgv: string[] } | null;
				launchError: string | null;
				isolatedChildMarkers: Array<string | null>;
				childrenSettled: boolean;
			};
			expect(result.launchError).toBeNull();
			expect(result.callerCount).toBe(1);
			expect(result.receipt?.kind).toBe("target-entry");
			expect(result.receipt?.execArgv).toEqual(["--import", loader, "--max-old-space-size=4096"]);
			// Only the bundled self-reexec reads the recursion marker; an unbundled cli-main child would leak it to
			// everything the agent spawns.
			expect(result.isolatedChildMarkers).toEqual([kind === "bundled" ? "1" : null]);
			expect(result.childrenSettled).toBe(true);
			expect(exitCode).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 100_000);
}
