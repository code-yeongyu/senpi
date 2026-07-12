import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const repositoryRoot = resolve(process.cwd(), "../..");
const verifier = join(repositoryRoot, "scripts", "verify-auth-broker-gateway.mjs");

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function fixture(): { evidence: string; manifest: string; plan: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-auth-broker-gateway-verifier-"));
	directories.push(root);
	const evidence = join(root, "evidence");
	mkdirSync(join(evidence, "final"), { recursive: true });
	const plan = join(root, "plan.md");
	writeFileSync(
		plan,
		[
			"/healthz",
			"/v1/models",
			"/v1/usage",
			"/v1/credentials/check",
			"/v1/chat/completions",
			"/v1/messages",
			"/v1/responses",
			"/v1/pi/stream",
			"gh-proxy",
			"arbitrary URLs",
			"no-auth",
			"wildcard CORS",
			"public binding",
		].join("\n"),
	);
	for (const [path, text] of [
		["final/f2-check.txt", "check clean\nexitCode: 0"],
		["final/f2-tests.txt", "tests clean\nexitCode: 0"],
		["final/f3-cli.txt", "real auth.json unchanged\nexitCode: 0"],
		["final/f3-loop.txt", "auth isolation passed\nexitCode: 0"],
		["final/f3-rpc.txt", "authentication isolation passed\nexitCode: 0"],
		["final/f3-happy.txt", "real surface happy\nexitCode: 0"],
		["final/f3-failure.txt", "real surface negative\nexitCode: 0"],
		["final/f3-secret-scan.txt", "secret scan clean\nexitCode: 0"],
		["final/f3-scope-scan.txt", "scope scan clean\nexitCode: 0"],
	] as const)
		writeFileSync(join(evidence, path), `${text}\n`);
	return { evidence, manifest: join(evidence, "evidence-manifest.json"), plan };
}

function run(args: readonly string[]) {
	return spawnSync(process.execPath, [verifier, ...args], { cwd: repositoryRoot, encoding: "utf8" });
}

describe("auth broker gateway verifier", () => {
	it("writes APPROVE for every verifier mode with a complete fresh manifest", () => {
		const { evidence, manifest, plan } = fixture();
		const write = run(["--write-manifest", "--evidence-root", evidence, "--out", manifest, "--plan", plan]);
		expect(write.status).toBe(0);
		for (const mode of ["plan", "quality", "real-surface", "scope"]) {
			const output = join(evidence, `${mode}.json`);
			const result = run(["--check", mode, "--manifest", manifest, "--plan", plan, "--evidence", output]);
			expect(result.status, result.stderr).toBe(0);
			expect(readFileSync(output, "utf8").trim()).toBe('{"verdict":"APPROVE"}');
		}
	});

	it("rejects missing stale malformed score-mismatched and security-failing evidence for every verifier mode", () => {
		const { evidence, manifest, plan } = fixture();
		expect(run(["--write-manifest", "--evidence-root", evidence, "--out", manifest, "--plan", plan]).status).toBe(0);
		const stale = join(evidence, "final", "f3-happy.txt");
		utimesSync(stale, new Date(Date.now() - 16 * 60 * 1000), new Date(Date.now() - 16 * 60 * 1000));
		for (const mode of ["plan", "quality", "real-surface", "scope"]) {
			const output = join(evidence, `${mode}-rejected.json`);
			const result = run(["--check", mode, "--manifest", manifest, "--plan", plan, "--evidence", output]);
			expect(result.status).not.toBe(0);
			expect(() => readFileSync(output, "utf8")).toThrow();
		}
		const malformed = join(evidence, "malformed.json");
		writeFileSync(malformed, "{not-json");
		expect(
			run(["--check", "quality", "--manifest", malformed, "--evidence", join(evidence, "bad.json")]).status,
		).not.toBe(0);
		const secret = join(evidence, "secret.txt");
		writeFileSync(secret, "refresh_token: not-a-real-secret-value");
		expect(
			run(["--scan-secrets", "--evidence-root", evidence, "--evidence", join(evidence, "secret-scan.txt")]).status,
		).not.toBe(0);
	});
});
