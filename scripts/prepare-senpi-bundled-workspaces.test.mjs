import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { rewriteOwnedRegistryAliases, stagePublishManifest } from "./prepare-senpi-publish-manifest.mjs";

let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

function writeCodingAgentManifest(root, overrides = {}) {
	writeJson(join(root, "packages", "coding-agent", "package.json"), {
		name: "@code-yeongyu/senpi",
		version: "2026.7.22",
		files: ["dist", "README.md"],
		dependencies: {
			"@code-yeongyu/senpi-codemode": "^2026.7.22",
			"@earendil-works/chord": "0.85.1",
			"@earendil-works/pi-ai": "^2026.7.22",
			"@earendil-works/pi-agent-core": "^2026.7.22",
			"@earendil-works/pi-client": "^2026.7.22",
			"@earendil-works/pi-protocol": "^2026.7.22",
			"cross-spawn": "7.0.6",
		},
		optionalDependencies: {
			"@earendil-works/pi-pty": "^2026.7.22",
			"@mariozechner/clipboard": "0.3.9",
		},
		bundleDependencies: ["@earendil-works/pi-ai", "cross-spawn"],
		bundledDependencies: ["@earendil-works/pi-ai", "cross-spawn"],
		...overrides,
	});
}

function readStagedManifest(root) {
	return JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8"));
}

describe("stagePublishManifest", () => {
	it("writes exactly the source dependencies minus the vendored ones, through owned registry aliases", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-manifest-"));
		writeCodingAgentManifest(tempDir);

		// When
		const returned = stagePublishManifest(tempDir);

		// Then: fork workspaces resolve from the registry through exact aliases, codemode keeps
		// its own published name at an exact version, and chord keeps upstream's release line.
		const manifest = readStagedManifest(tempDir);
		assert.deepEqual(returned, manifest);
		assert.deepEqual(manifest.dependencies, {
			"@code-yeongyu/senpi-codemode": "2026.7.22",
			"@earendil-works/chord": "0.85.1",
			"@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@2026.7.22",
			"@earendil-works/pi-agent-core": "npm:@code-yeongyu/senpi-agent-core@2026.7.22",
			"cross-spawn": "7.0.6",
		});
		assert.deepEqual(manifest.optionalDependencies, {
			"@earendil-works/pi-pty": "npm:@code-yeongyu/senpi-pty@2026.7.22",
			"@mariozechner/clipboard": "0.3.9",
		});
	});

	it("drops both bundle fields so the tarball ships no dependency tree", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-bundle-fields-"));
		writeCodingAgentManifest(tempDir);

		// When
		stagePublishManifest(tempDir);

		// Then
		const manifest = readStagedManifest(tempDir);
		assert.equal(Object.hasOwn(manifest, "bundleDependencies"), false);
		assert.equal(Object.hasOwn(manifest, "bundledDependencies"), false);
	});

	it("stages from the manifest alone, without materializing node_modules or promoting optionals", () => {
		// Given: no installed dependency tree exists anywhere in the fixture.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-no-tree-"));
		writeCodingAgentManifest(tempDir, {
			dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.220" },
			optionalDependencies: {},
		});

		// When
		stagePublishManifest(tempDir);

		// Then: platform binaries stay optional edges of the SDK that owns them.
		const manifest = readStagedManifest(tempDir);
		assert.deepEqual(manifest.dependencies, { "@anthropic-ai/claude-agent-sdk": "0.3.220" });
		assert.deepEqual(manifest.optionalDependencies, {});
		assert.equal(existsSync(join(tempDir, "packages", "coding-agent", "node_modules")), false);
	});

	it("adds vendor to files once and requires a files list", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-files-"));
		writeCodingAgentManifest(tempDir, { files: ["dist", "vendor", "README.md"] });

		// When
		stagePublishManifest(tempDir);

		// Then
		assert.deepEqual(readStagedManifest(tempDir).files, ["dist", "vendor", "README.md"]);
		writeCodingAgentManifest(tempDir, { files: ["dist"] });
		stagePublishManifest(tempDir);
		assert.deepEqual(readStagedManifest(tempDir).files, ["dist", "vendor"]);
		writeCodingAgentManifest(tempDir, { files: undefined });
		assert.throws(() => stagePublishManifest(tempDir), /must declare files before adding vendor output/);
	});

	for (const spec of ["file:../local-pkg", "link:../local-pkg", "workspace:*"]) {
		it(`throws when a dependency spec uses the local ${spec.split(":")[0]}: protocol`, () => {
			// Given
			tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-local-spec-"));
			writeCodingAgentManifest(tempDir, { optionalDependencies: { "local-pkg": spec } });

			// When / Then
			assert.throws(() => stagePublishManifest(tempDir), /optionalDependencies\.local-pkg uses a local spec/);
		});
	}

	it("throws when the manifest declares a never-published fork package (senpi#2141)", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-unpublished-"));
		writeCodingAgentManifest(tempDir, {
			dependencies: { "@code-yeongyu/senpi-never-published": "2026.7.22", "cross-spawn": "7.0.6" },
		});

		// When / Then
		assert.throws(
			() => stagePublishManifest(tempDir),
			/declares packages that are never published.*@code-yeongyu\/senpi-never-published/,
		);
	});
});

describe("rewriteOwnedRegistryAliases", () => {
	it("keeps an existing npm: alias and rejects a non-exact internal range", () => {
		// Given
		const aliased = { dependencies: { "@earendil-works/pi-tui": "npm:@code-yeongyu/senpi-tui@2026.7.22" } };
		const ranged = { dependencies: { "@earendil-works/pi-tui": ">=2026.7.22" } };

		// When / Then
		assert.deepEqual(rewriteOwnedRegistryAliases(aliased).dependencies, {
			"@earendil-works/pi-tui": "npm:@code-yeongyu/senpi-tui@2026.7.22",
		});
		assert.throws(() => rewriteOwnedRegistryAliases(ranged), /must use an exact version, received >=2026\.7\.22/);
	});
});
