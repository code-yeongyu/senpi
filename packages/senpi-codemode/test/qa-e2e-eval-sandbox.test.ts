import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const qaDriver = fileURLToPath(new URL("../scripts/qa-e2e-eval.ts", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe("qa-e2e-eval sandbox", () => {
	it("leaves an inherited Senpi agent directory untouched", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "senpi-codemode-qa-isolation-"));
		tempDirs.push(tempRoot);
		const inheritedAgentDir = join(tempRoot, "inherited-agent");
		const sentinelPath = join(inheritedAgentDir, "sentinel.txt");
		mkdirSync(inheritedAgentDir);
		writeFileSync(sentinelPath, "must survive\n");

		const result = spawnSync(process.execPath, ["--import", "tsx", qaDriver], {
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				PI_OFFLINE: "1",
				SENPI_CODING_AGENT_DIR: inheritedAgentDir,
			},
			timeout: 30_000,
		});

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(existsSync(sentinelPath)).toBe(true);
		expect(readFileSync(sentinelPath, "utf8")).toBe("must survive\n");
		expect(readdirSync(inheritedAgentDir)).toEqual(["sentinel.txt"]);
	});
});
