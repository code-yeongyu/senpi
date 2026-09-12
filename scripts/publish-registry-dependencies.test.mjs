import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { bundledWorkspacePackageChecks } from "./prepare-senpi-bundled-workspaces.mjs";
import { registryPackageNames } from "./registry-packages.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PRIVATE_UPSTREAM_WORKSPACES = [
	{ packageJsonPath: "packages/chord/package.json", packageName: "@earendil-works/chord" },
	{ packageJsonPath: "packages/ai/package.json", packageName: "@earendil-works/pi-ai" },
	{ packageJsonPath: "packages/agent/package.json", packageName: "@earendil-works/pi-agent-core" },
	{ packageJsonPath: "packages/tui/package.json", packageName: "@earendil-works/pi-tui" },
	{ packageJsonPath: "packages/pty/package.json", packageName: "@earendil-works/pi-pty" },
	{ packageJsonPath: "packages/telemetry/package.json", packageName: "@earendil-works/pi-telemetry" },
];
const INDEPENDENT_UPSTREAM_WORKSPACES = [
	{
		packageJsonPath: "packages/session-backends/sqlite-node/package.json",
		packageName: "@earendil-works/pi-storage-sqlite-node",
	},
];
const OWNED_REGISTRY_ALIASES = [
	"@code-yeongyu/senpi-chord",
	"@code-yeongyu/senpi-ai",
	"@code-yeongyu/senpi-agent-core",
	"@code-yeongyu/senpi-tui",
	"@code-yeongyu/senpi-pty",
	"@code-yeongyu/senpi-telemetry",
	"@code-yeongyu/senpi-codemode",
	"@code-yeongyu/senpi",
];
const BUNDLED_ONLY_WORKSPACES = ["@code-yeongyu/senpi-client", "@code-yeongyu/senpi-protocol"];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("npm publish dependency graph", () => {
	it("keeps upstream workspaces private and publishes owned registry aliases", () => {
		// Given: Bun resolves declared edges from the registry, but npm only packs the
		// original import paths when their dependency keys remain in the manifest.
		const publishedNames = getPublicWorkspacePackages().map(({ name }) => name);
		assert.equal(readJson(join(repoRoot, "packages/server/package.json")).private, true);
		assert.ok(!publishedNames.includes("@code-yeongyu/senpi-server"));

		for (const workspace of PRIVATE_UPSTREAM_WORKSPACES) {
			const manifest = readJson(join(repoRoot, workspace.packageJsonPath));
			assert.equal(manifest.private, true, `${workspace.packageName} must remain private`);
		}
		for (const workspace of INDEPENDENT_UPSTREAM_WORKSPACES) {
			const manifest = readJson(join(repoRoot, workspace.packageJsonPath));
			const aiManifest = readJson(join(repoRoot, "packages/ai/package.json"));
			const agentManifest = readJson(join(repoRoot, "packages/agent/package.json"));
			assert.equal(manifest.private, true, `${workspace.packageName} must remain excluded from fork publishing`);
			assert.ok(!publishedNames.includes(workspace.packageName));
			assert.equal(manifest.dependencies["@earendil-works/pi-agent-core"], `^${agentManifest.version}`);
			assert.equal(manifest.dependencies["@earendil-works/pi-ai"], `^${aiManifest.version}`);
			assert.equal(manifest.devDependencies["@earendil-works/pi-agent-core"], undefined);
			assert.equal(manifest.devDependencies["@earendil-works/pi-ai"], undefined);
		}
		for (const packageName of OWNED_REGISTRY_ALIASES) {
			assert.ok(publishedNames.includes(packageName));
		}
		for (const packageName of BUNDLED_ONLY_WORKSPACES) {
			assert.ok(!publishedNames.includes(packageName));
		}
	});

	it("publishes a registry alias for every bundled workspace", () => {
		// Given: npm installs a bundled workspace from the packed copy, but Bun resolves the
		// declared edge from the registry and synthesizes `^<bundled version>` when the manifest
		// has none. A bundled workspace without an owned alias therefore ships a CalVer spec no
		// upstream release satisfies, and `bun add @code-yeongyu/senpi@<version>` fails outright
		// (issue #1632: chord shipped that way in 2026.9.12-3).
		const publishedNames = getPublicWorkspacePackages().map(({ name }) => name);
		const unaliased = [];
		for (const { packageName } of bundledWorkspacePackageChecks()) {
			const registryName = registryPackageNames.get(packageName);
			if (registryName === undefined || !publishedNames.includes(registryName)) {
				unaliased.push(packageName);
			}
		}
		assert.deepEqual(unaliased, [], `bundled workspaces without a published registry alias: ${unaliased.join(", ")}`);
	});
});
