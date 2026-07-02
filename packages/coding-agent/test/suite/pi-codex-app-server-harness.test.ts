import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function harnessPath(): string {
	return join(process.cwd(), "src", "core", "extensions", "builtin", "pi-codex-app-server", "qa", "drive-adapter.mjs");
}

describe("pi-codex-app-server runtime harness", () => {
	it("exposes help without starting runtime transport", () => {
		const result = spawnSync(process.execPath, [harnessPath(), "--help"], {
			cwd: process.cwd(),
			encoding: "utf-8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("pi-codex-app-server adapter harness");
		expect(result.stdout).toContain("--external-stdio");
		expect(result.stdout).toContain("--app-server-url");
		expect(result.stdout).toContain("write-evidence-packet.mjs for PR-012 redaction packets");
		expect(result.stderr).toBe("");
	});

	it("fails runtime smoke on immediate nonzero child exit and writes a clean receipt", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-codex-harness-test-"));
		try {
			const failingScript = join(tempRoot, "fail-now.mjs");
			const cleanupReceipt = join(tempRoot, "cleanup-receipt.txt");
			writeFileSync(failingScript, "setTimeout(() => process.exit(42), 0);\n");

			const result = spawnSync(
				process.execPath,
				[
					harnessPath(),
					"--external-stdio",
					"--app-server-command",
					process.execPath,
					"--app-server-args",
					failingScript,
					"--timeout-ms",
					"1000",
					"--cleanup-receipt",
					cleanupReceipt,
				],
				{ cwd: process.cwd(), encoding: "utf-8" },
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("exited before health window with code 42");
			expect(readFileSync(cleanupReceipt, "utf-8")).toContain("childProcesses=0");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("fails runtime smoke on immediate zero child exit and writes a clean receipt", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-codex-harness-test-"));
		try {
			const exitingScript = join(tempRoot, "exit-now.mjs");
			const cleanupReceipt = join(tempRoot, "cleanup-receipt.txt");
			writeFileSync(exitingScript, "setTimeout(() => process.exit(0), 0);\n");

			const result = spawnSync(
				process.execPath,
				[
					harnessPath(),
					"--external-stdio",
					"--app-server-command",
					process.execPath,
					"--app-server-args",
					exitingScript,
					"--timeout-ms",
					"1000",
					"--cleanup-receipt",
					cleanupReceipt,
				],
				{ cwd: process.cwd(), encoding: "utf-8" },
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("exited before health window with code 0");
			expect(readFileSync(cleanupReceipt, "utf-8")).toContain("childProcesses=0");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("fails runtime smoke when child spawn fails and writes a clean receipt", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-codex-harness-test-"));
		try {
			const cleanupReceipt = join(tempRoot, "cleanup-receipt.txt");

			const result = spawnSync(
				process.execPath,
				[
					harnessPath(),
					"--external-stdio",
					"--app-server-command",
					join(tempRoot, "missing-app-server"),
					"--timeout-ms",
					"1000",
					"--cleanup-receipt",
					cleanupReceipt,
				],
				{ cwd: process.cwd(), encoding: "utf-8" },
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("ENOENT");
			expect(readFileSync(cleanupReceipt, "utf-8")).toContain("childProcesses=0");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
