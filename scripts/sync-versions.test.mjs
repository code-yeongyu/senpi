import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

test("synchronizes private dependencies without touching registry aliases, generated manifests, or published lockstep", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "2.0.0",
			private: true,
		});
		await writeManifest(root, "packages/coding-agent", {
			name: "@code-yeongyu/senpi",
			version: "2.0.0",
			private: true,
		});
		for (const [directory, name] of [
			["agent", "@earendil-works/pi-agent-core"],
			["tui", "@earendil-works/pi-tui"],
			["pty", "@earendil-works/pi-pty"],
			["telemetry", "@earendil-works/pi-telemetry"],
			["senpi-codemode", "@code-yeongyu/senpi-codemode"],
		]) {
			await writeManifest(root, `packages/${directory}`, {
				name,
				version: "2.0.0",
				private: true,
			});
		}
		await writeManifest(root, "packages/evals", {
			name: "@earendil-works/pi-evals",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@code-yeongyu/senpi": "^1.0.0",
				"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@1.0.0",
				"@earendil-works/pi-storage-sqlite-node": "^0.70.0",
			},
		});
		await writeManifest(root, "packages/session-backends/sqlite-node", {
			name: "@earendil-works/pi-storage-sqlite-node",
			version: "0.83.0",
			private: true,
			dependencies: {
				"@earendil-works/pi-agent-core": "^1.0.0",
				"@earendil-works/pi-ai": "^1.0.0",
			},
		});
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"@code-yeongyu/senpi": "^1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const evalsManifest = await readManifest(root, "packages/evals");
		assert.equal(evalsManifest.dependencies["@code-yeongyu/senpi"], "^2.0.0");
		assert.equal(evalsManifest.dependencies["@mariozechner/pi-ai"], "npm:@earendil-works/pi-ai@1.0.0");
		assert.equal(evalsManifest.dependencies["@earendil-works/pi-storage-sqlite-node"], "^0.70.0");
		const sqliteManifest = await readManifest(root, "packages/session-backends/sqlite-node");
		assert.equal(sqliteManifest.version, "0.83.0");
		assert.equal(sqliteManifest.dependencies["@earendil-works/pi-agent-core"], "^2.0.0");
		assert.equal(sqliteManifest.dependencies["@earendil-works/pi-ai"], "^2.0.0");
		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["@code-yeongyu/senpi"], "^1.0.0");

		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "3.0.0",
			private: true,
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
