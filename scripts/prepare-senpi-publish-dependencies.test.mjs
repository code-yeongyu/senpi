import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { stagePublishDependencies } from "./prepare-senpi-publish-dependencies.mjs";

const internalPackageNames = new Set(["@earendil-works/pi-ai"]);
let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writePackage(root, name, version = "1.0.0") {
	const packageDir = join(root, "node_modules", name);
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name, version }, undefined, "\t")}\n`);
	return packageDir;
}

function writeManifest(root, packages) {
	const manifestPath = join(root, "packages", "coding-agent", "publish-deps.lock.json");
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, JSON.stringify({ name: "@code-yeongyu/senpi", version: "0.0.0", lockfileVersion: 3, packages }));
}

function stagedVersion(root, lockPath) {
	const packageJson = join(root, "packages", "coding-agent", lockPath, "package.json");
	return existsSync(packageJson) ? JSON.parse(readFileSync(packageJson, "utf8")).version : undefined;
}

describe("stagePublishDependencies", () => {
	it("stages a nested manifest entry from the installer-hoisted copy and prunes packages the manifest dropped", () => {
		// Given: bun hoisted htmlparser2's entities@7 to the root, while the staged tree still
		// carries entities@8 and parse5 from the previous (jsdom) graph plus a stale nested dep.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-nested-"));
		writePackage(tempDir, "htmlparser2", "10.1.0");
		writePackage(join(tempDir, "node_modules", "htmlparser2"), "installer-extra");
		writePackage(tempDir, "entities", "7.0.1");
		const stagedRoot = join(tempDir, "packages", "coding-agent");
		writePackage(stagedRoot, "entities", "8.0.0");
		writePackage(stagedRoot, "parse5", "8.0.1");
		writePackage(join(stagedRoot, "node_modules", "htmlparser2"), "stale-nested");
		writePackage(stagedRoot, "@earendil-works/pi-ai");
		// ...and a scoped parent whose scoped child is nested at the same place under the root install.
		writePackage(tempDir, "@aws-sdk/token-providers", "3.1127.0");
		writePackage(writePackage(tempDir, "@aws-sdk/credential-provider-sso", "3.973.15"), "@aws-sdk/token-providers", "3.1129.0");
		writeManifest(tempDir, {
			"": { dependencies: { htmlparser2: "10.1.0", "@aws-sdk/credential-provider-sso": "3.973.15" } },
			"node_modules/htmlparser2": { version: "10.1.0" },
			"node_modules/htmlparser2/node_modules/entities": { version: "7.0.1" },
			"node_modules/@aws-sdk/token-providers": { version: "3.1127.0" },
			"node_modules/@aws-sdk/credential-provider-sso": { version: "3.973.15" },
			"node_modules/@aws-sdk/credential-provider-sso/node_modules/@aws-sdk/token-providers": { version: "3.1129.0" },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then: the tree mirrors the manifest; internal workspaces are left for their own staging.
		assert.equal(stagedVersion(tempDir, "node_modules/htmlparser2"), "10.1.0");
		assert.equal(stagedVersion(tempDir, "node_modules/htmlparser2/node_modules/entities"), "7.0.1");
		assert.equal(stagedVersion(tempDir, "node_modules/entities"), undefined);
		assert.equal(stagedVersion(tempDir, "node_modules/parse5"), undefined);
		assert.equal(stagedVersion(tempDir, "node_modules/htmlparser2/node_modules/stale-nested"), undefined);
		assert.equal(stagedVersion(tempDir, "node_modules/htmlparser2/node_modules/installer-extra"), undefined);
		assert.equal(stagedVersion(tempDir, "node_modules/@earendil-works/pi-ai"), "1.0.0");
		assert.equal(stagedVersion(tempDir, "node_modules/@aws-sdk/token-providers"), "3.1127.0");
		assert.equal(stagedVersion(tempDir, "node_modules/@aws-sdk/credential-provider-sso/node_modules/@aws-sdk/token-providers"), "3.1129.0");
	});

	it("never substitutes a copy of another version and finds the matching copy nested under another dependent", () => {
		// Given: the manifest hoists x@2 while the developer's install hoisted x@1 and nested x@2 under a.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-version-"));
		writePackage(tempDir, "x", "1.0.0");
		writePackage(writePackage(tempDir, "a", "1.0.0"), "x", "2.0.0");
		writeManifest(tempDir, {
			"": { dependencies: { a: "1.0.0", x: "2.0.0" } },
			"node_modules/a": { version: "1.0.0" },
			"node_modules/x": { version: "2.0.0" },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then
		assert.equal(stagedVersion(tempDir, "node_modules/x"), "2.0.0");
		assert.equal(stagedVersion(tempDir, "node_modules/a"), "1.0.0");
	});

	it("stages the workspace-local copy at the top level and re-nests the root copy under its dependent", () => {
		// Given: npm resolved diff@9 workspace-locally and diff@8 at the root for old-consumer;
		// bun hoisted 9 and nested 8 under the consumer.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-workspace-local-"));
		writePackage(tempDir, "diff", "9.0.0");
		writePackage(writePackage(tempDir, "old-consumer"), "diff", "8.0.0");
		writeManifest(tempDir, {
			"": { dependencies: { diff: "9.0.0", "old-consumer": "1.0.0" } },
			"node_modules/diff": { version: "8.0.0" },
			"node_modules/old-consumer": { version: "1.0.0", dependencies: { diff: "^8" } },
			"packages/coding-agent/node_modules/diff": { version: "9.0.0" },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then
		assert.equal(stagedVersion(tempDir, "node_modules/diff"), "9.0.0");
		assert.equal(stagedVersion(tempDir, "node_modules/old-consumer/node_modules/diff"), "8.0.0");
	});

	it("fails loudly with the expected version when no installed copy matches the manifest", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-mismatch-"));
		writePackage(tempDir, "x", "1.0.0");
		writeManifest(tempDir, { "": { dependencies: { x: "2.0.0" } }, "node_modules/x": { version: "2.0.0" } });

		assert.throws(() => stagePublishDependencies(tempDir, internalPackageNames), /Missing .*node_modules\/x@2\.0\.0 for node_modules\/x/);
	});

	it("keeps a child whose only matching copy sits inside the parent being replaced", () => {
		// Given: the root install has parent@1 without its children, while the staged tree
		// already holds parent@1 with the only copies of a required and an optional child.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-staged-only-child-"));
		writePackage(tempDir, "parent");
		const stagedParent = writePackage(join(tempDir, "packages", "coding-agent"), "parent");
		writePackage(stagedParent, "child", "1.5.0");
		writePackage(stagedParent, "opt-child", "2.5.0");
		writeManifest(tempDir, {
			"": { dependencies: { parent: "1.0.0" } },
			"node_modules/parent": { version: "1.0.0" },
			"node_modules/parent/node_modules/child": { version: "1.5.0" },
			"node_modules/parent/node_modules/opt-child": { version: "2.5.0", optional: true },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then: both children survive the parent's replacement at their manifest versions.
		assert.equal(stagedVersion(tempDir, "node_modules/parent"), "1.0.0");
		assert.equal(stagedVersion(tempDir, "node_modules/parent/node_modules/child"), "1.5.0");
		assert.equal(stagedVersion(tempDir, "node_modules/parent/node_modules/opt-child"), "2.5.0");
	});

	it("reports a candidate whose package.json is not valid JSON instead of treating it as absent", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-broken-manifest-"));
		const brokenDir = join(tempDir, "packages", "coding-agent", "node_modules", "platform-opt");
		mkdirSync(brokenDir, { recursive: true });
		writeFileSync(join(brokenDir, "package.json"), "{ not json");
		writeManifest(tempDir, {
			"": { optionalDependencies: { "platform-opt": "3.0.0" } },
			"node_modules/platform-opt": { version: "3.0.0", optional: true },
		});

		assert.throws(() => stagePublishDependencies(tempDir, internalPackageNames), /platform-opt\/package\.json is not valid JSON/);
	});

	it("removes a stale copy of an optional entry that no installed package matches", () => {
		// Given: the staged tree still carries platform-opt@2 from an earlier graph; the manifest
		// wants 3.0.0 and nothing installed provides it.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-stale-optional-"));
		writePackage(join(tempDir, "packages", "coding-agent"), "platform-opt", "2.0.0");
		writeManifest(tempDir, {
			"": { optionalDependencies: { "platform-opt": "3.0.0" } },
			"node_modules/platform-opt": { version: "3.0.0", optional: true },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then: the wrong version is gone rather than packed under the manifest's name.
		assert.equal(existsSync(join(tempDir, "packages", "coding-agent", "node_modules", "platform-opt")), false);
	});

	it("keeps a materialized optional package in place when the root install lacks it", () => {
		// Given: publish.mjs downloaded a platform optional straight into the staged tree.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-optional-"));
		writePackage(join(tempDir, "packages", "coding-agent"), "platform-opt", "3.0.0");
		writeManifest(tempDir, {
			"": { optionalDependencies: { "platform-opt": "3.0.0", "absent-opt": "1.0.0" } },
			"node_modules/platform-opt": { version: "3.0.0", optional: true },
			"node_modules/platform-opt/node_modules/absent-child": { version: "1.0.0", optional: true },
			"node_modules/absent-opt": { version: "1.0.0", optional: true },
			"node_modules/absent-opt/node_modules/absent-child": { version: "1.0.0", optional: true },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then
		assert.equal(stagedVersion(tempDir, "node_modules/platform-opt"), "3.0.0");
		assert.equal(stagedVersion(tempDir, "node_modules/absent-opt"), undefined);
		assert.equal(existsSync(join(tempDir, "packages", "coding-agent", "node_modules", "absent-opt")), false);
	});
});
