#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

function writePackage(packagesDir, packageDir, packageJson) {
	const dir = join(packagesDir, packageDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(packageJson, null, "\t")}\n`);
}

function readPackage(packagesDir, packageDir) {
	return JSON.parse(readFileSync(join(packagesDir, packageDir, "package.json"), "utf8"));
}

describe("sync-versions", () => {
	it("keeps senpi source dependencies on local workspace versions", () => {
		// Given
		const fixtureRoot = mkdtempSync(join(tmpdir(), "sync-versions-"));
		const packagesDir = join(fixtureRoot, "packages");
		try {
			writePackage(packagesDir, "agent", {
				name: "@earendil-works/pi-agent-core",
				version: "2026.5.19",
			});
			writePackage(packagesDir, "ai", {
				name: "@earendil-works/pi-ai",
				version: "2026.5.19",
			});
			writePackage(packagesDir, "tui", {
				name: "@earendil-works/pi-tui",
				version: "2026.5.19",
			});
			writePackage(packagesDir, "pty", {
				name: "@earendil-works/pi-pty",
				version: "2026.5.19",
			});
			writePackage(packagesDir, "web-ui", {
				name: "@earendil-works/pi-web-ui",
				version: "2026.5.19",
				dependencies: {
					"@earendil-works/pi-agent-core": "^0.74.0",
					"@earendil-works/pi-ai": "^0.74.0",
					"@earendil-works/pi-pty": "^0.74.0",
					"@earendil-works/pi-tui": "^0.74.0",
				},
			});
			writePackage(packagesDir, "coding-agent", {
				name: "@code-yeongyu/senpi",
				version: "2026.5.19",
				dependencies: {
					"@earendil-works/pi-agent-core": "^0.74.0",
					"@earendil-works/pi-ai": "^0.74.0",
					"@earendil-works/pi-pty": "^0.74.0",
					"@earendil-works/pi-tui": "^0.74.0",
				},
			});

			// When
			execFileSync(process.execPath, [join(root, "scripts/sync-versions.js")], {
				cwd: fixtureRoot,
				stdio: "pipe",
			});

			// Then
			const senpiPackage = readPackage(packagesDir, "coding-agent");
			assert.deepEqual(senpiPackage.dependencies, {
				"@earendil-works/pi-agent-core": "^2026.5.19",
				"@earendil-works/pi-ai": "^2026.5.19",
				"@earendil-works/pi-pty": "^2026.5.19",
				"@earendil-works/pi-tui": "^2026.5.19",
			});
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
