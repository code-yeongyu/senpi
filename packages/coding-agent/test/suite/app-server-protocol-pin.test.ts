import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const protocolDir = join(process.cwd(), "src/modes/app-server/protocol");
const generatedDir = join(protocolDir, "generated");
const codexCheckoutDir = "/Users/yeongyu/local-workspaces/codex";
const codexCheckoutGeneratedDir = join(codexCheckoutDir, "codex-rs/app-server-protocol/schema/typescript");
const protocolVersionPath = join(protocolDir, "PROTOCOL_VERSION.txt");
const generatorPath = join(process.cwd(), "scripts/generate-app-server-protocol.sh");
const expectedSha = "9fc715c0861c956c894a91890b78dc05b304ba29";
const expectedAuthorDate = "2026-07-22";
const expectedVersion = `codex-git ${expectedSha} (${expectedAuthorDate})`;

function listFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? listFiles(path) : [path];
	});
}

function relativeFiles(dir: string): string[] {
	return listFiles(dir)
		.map((path) => relative(dir, path))
		.sort();
}

describe("app-server protocol pin", () => {
	it("records the exact Codex checkout SHA and author date", () => {
		const version = readFileSync(protocolVersionPath, "utf8").trim();

		expect(version).toBe(expectedVersion);
	});

	it.skipIf(!existsSync(codexCheckoutGeneratedDir))("matches the pinned Codex checkout byte-for-byte", () => {
		expect(gitOutput(["rev-parse", "HEAD"])).toBe(expectedSha);
		expect(gitOutput(["show", "-s", "--format=%as", "HEAD"])).toBe(expectedAuthorDate);

		const actualFiles = relativeFiles(generatedDir).filter((path) => path !== "package.json");
		const expectedFiles = relativeFiles(codexCheckoutGeneratedDir);

		expect(actualFiles).toEqual(expectedFiles);

		for (const path of expectedFiles) {
			const actual = readFileSync(join(generatedDir, path));
			const expected = readFileSync(join(codexCheckoutGeneratedDir, path));

			expect(actual).toEqual(expected);
		}
	});

	it("rejects a missing checkout without changing the vendored tree or version", () => {
		const before = protocolFingerprint();

		const result = spawnSync("bash", [generatorPath, "--from-checkout", "/definitely/missing"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(result.status).not.toBe(0);
		expect(protocolFingerprint()).toBe(before);
	});
});

function gitOutput(args: readonly string[]): string {
	const result = spawnSync("git", ["-C", codexCheckoutDir, ...args], { encoding: "utf8" });
	expect(result.status).toBe(0);
	return result.stdout.trim();
}

function protocolFingerprint(): string {
	const hash = createHash("sha256");
	hash.update(readFileSync(protocolVersionPath));
	for (const path of relativeFiles(generatedDir)) {
		hash.update(path);
		hash.update("\0");
		hash.update(readFileSync(join(generatedDir, path)));
		hash.update("\0");
	}
	return hash.digest("hex");
}
