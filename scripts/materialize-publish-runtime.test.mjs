import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collectMissingLockedRuntimePackages, materializeMissingPublishRuntime } from "./materialize-publish-runtime.mjs";

describe("publish runtime materialization", () => {
	it("selects only absent locked optional registry packages", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-runtime-test-"));
		const lock = {
			packages: {
				"node_modules/@scope/missing": {
					optional: true,
					resolved: "https://registry.example/missing.tgz",
					integrity: "sha512-example",
				},
				"node_modules/ordinary": {
					optional: false,
					resolved: "https://registry.example/ordinary.tgz",
					integrity: "sha512-example",
				},
				"node_modules/build-only": {
					optional: true,
					resolved: "https://registry.example/build-only.tgz",
					integrity: "sha512-example",
				},
			},
		};
		const publishLock = {
			packages: {
				"node_modules/@scope/missing": lock.packages["node_modules/@scope/missing"],
				"node_modules/ordinary": lock.packages["node_modules/ordinary"],
			},
		};

		assert.deepEqual(collectMissingLockedRuntimePackages(publishLock, root), [
			{
				packageName: "@scope/missing",
				target: join(root, "@scope/missing"),
				resolved: "https://registry.example/missing.tgz",
				integrity: "sha512-example",
			},
		]);
		rmSync(root, { recursive: true, force: true });
	});

	it("verifies and extracts an exact locked tarball", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-runtime-test-"));
		const fixture = mkdtempSync(join(tmpdir(), "senpi-runtime-fixture-"));
		const packageDir = join(fixture, "package");
		const archivePath = join(fixture, "fixture.tgz");
		await import("node:fs/promises").then(({ mkdir, writeFile }) =>
			mkdir(packageDir).then(() => writeFile(join(packageDir, "package.json"), '{"name":"@scope/native"}\n')),
		);
		const { spawnSync } = await import("node:child_process");
		assert.equal(spawnSync("tar", ["-czf", archivePath, "-C", fixture, "package"]).status, 0);
		const archive = readFileSync(archivePath);
		const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
		const lockPath = join(root, "package-lock.json");
		writeFileSync(
			lockPath,
			JSON.stringify({
				packages: {
					"node_modules/@scope/native": {
						optional: true,
						resolved: "https://registry.example/native.tgz",
						integrity,
					},
				},
			}),
		);

		const materialized = await materializeMissingPublishRuntime({
			lockPath,
			root: join(root, "node_modules"),
			fetchImpl: async () => new Response(archive),
			log: () => {},
		});

		assert.deepEqual(materialized, ["@scope/native"]);
		assert.equal(existsSync(join(root, "node_modules/@scope/native/package.json")), true);
		assert.equal(existsSync(packageDir), true, "materialization must copy before cleaning its own extraction root");
		rmSync(root, { recursive: true, force: true });
		rmSync(fixture, { recursive: true, force: true });
	});
});
