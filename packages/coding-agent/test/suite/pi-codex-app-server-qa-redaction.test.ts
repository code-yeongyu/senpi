import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FAKE_SECRET = "pi_codex_fake_secret_DO_NOT_LEAK_20260624";

function packetScriptPath(): string {
	return join(
		process.cwd(),
		"src",
		"core",
		"extensions",
		"builtin",
		"pi-codex-app-server",
		"qa",
		"write-evidence-packet.mjs",
	);
}

describe("pi-codex-app-server QA redaction harness", () => {
	it("writes a sanitized reviewer packet with assertions and cleanup receipt", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-codex-qa-redaction-test-"));
		try {
			const inputPath = join(tempRoot, "packet-input.json");
			const packetDir = join(tempRoot, "packet");
			writeFileSync(
				inputPath,
				JSON.stringify({
					title: "PR-012 redaction smoke",
					commands: [
						{
							command: `codex app-server --token ${FAKE_SECRET}`,
							exitCode: 0,
							output: `connected with CODEX_ACCESS_TOKEN=${FAKE_SECRET}`,
						},
					],
					transcript: [
						{
							stream: "stderr",
							message: `Authorization: Bearer ${FAKE_SECRET}`,
						},
					],
					assertions: [
						{
							name: "cleanup receipt exists",
							passed: true,
							details: `assertion observed ${FAKE_SECRET}`,
						},
					],
					residualRisks: ["PR-013 final scenario matrix remains gated."],
					cleanup: {
						childProcesses: 0,
						websockets: 0,
						ownedSockets: 0,
						externalSocketPathsReferenced: 0,
					},
					seededSecrets: [FAKE_SECRET],
				}),
			);

			const result = spawnSync(process.execPath, [packetScriptPath(), "--input", inputPath, "--out", packetDir], {
				cwd: process.cwd(),
				encoding: "utf-8",
			});

			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			for (const fileName of [
				"summary.md",
				"commands.txt",
				"sanitized-transcript.jsonl",
				"assertions.json",
				"redaction-report.txt",
				"residual-risks.md",
				"cleanup-receipt.txt",
			]) {
				expect(existsSync(join(packetDir, fileName))).toBe(true);
			}
			expect(readFileSync(join(packetDir, "commands.txt"), "utf-8")).not.toContain(FAKE_SECRET);
			expect(readFileSync(join(packetDir, "sanitized-transcript.jsonl"), "utf-8")).not.toContain(FAKE_SECRET);
			expect(readFileSync(join(packetDir, "assertions.json"), "utf-8")).not.toContain(FAKE_SECRET);
			expect(readFileSync(join(packetDir, "redaction-report.txt"), "utf-8")).toContain("PASS no secret leaks found");
			expect(readFileSync(join(packetDir, "cleanup-receipt.txt"), "utf-8")).toContain("childProcesses=0");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("fails closed when an existing artifact contains a seeded fake secret", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-codex-qa-redaction-test-"));
		try {
			const leakPath = join(tempRoot, "leaky.txt");
			writeFileSync(leakPath, `raw secret ${FAKE_SECRET}\n`);

			const result = spawnSync(
				process.execPath,
				[packetScriptPath(), "--scan", tempRoot, "--seeded-secret", FAKE_SECRET],
				{ cwd: process.cwd(), encoding: "utf-8" },
			);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("FAIL secret leaks found");
			expect(result.stdout).toContain("leaky.txt");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("fails closed when a packet assertion fails", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-codex-qa-redaction-test-"));
		try {
			const inputPath = join(tempRoot, "packet-input.json");
			const packetDir = join(tempRoot, "packet");
			writeFileSync(
				inputPath,
				JSON.stringify({
					title: "PR-012 assertion failure smoke",
					commands: [{ command: "node qa-smoke.mjs", exitCode: 1, output: "assertion failed" }],
					transcript: [],
					assertions: [{ name: "negative harness exits nonzero", passed: false, details: "status was 0" }],
					residualRisks: [],
					cleanup: {
						childProcesses: 0,
						websockets: 0,
						ownedSockets: 0,
						externalSocketPathsReferenced: 0,
					},
					seededSecrets: [FAKE_SECRET],
				}),
			);

			const result = spawnSync(process.execPath, [packetScriptPath(), "--input", inputPath, "--out", packetDir], {
				cwd: process.cwd(),
				encoding: "utf-8",
			});

			expect(result.status).toBe(1);
			expect(result.stdout).toContain("FAIL assertions failed");
			expect(readFileSync(join(packetDir, "assertions.json"), "utf-8")).toContain("negative harness exits nonzero");
			expect(readFileSync(join(packetDir, "cleanup-receipt.txt"), "utf-8")).toContain("childProcesses=0");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
