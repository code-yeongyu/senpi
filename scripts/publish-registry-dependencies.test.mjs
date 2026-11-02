import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import semver from "semver";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { ownedRegistryAliases, stagePublishManifest } from "./prepare-senpi-publish-manifest.mjs";
import { registryPackageNames, registrySourcePackageNames } from "./registry-packages.mjs";
import { BUNDLED_INTERNAL_WORKSPACES, WORKSPACE_PACKAGES, getPublicWorkspacePackages } from "./release-packages.mjs";
import { assertSenpiPackedWorkspaceFiles } from "./senpi-publish-pack-checks.mjs";

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
	"@code-yeongyu/senpi-ai",
	"@code-yeongyu/senpi-agent-core",
	"@code-yeongyu/senpi-tui",
	"@code-yeongyu/senpi-pty",
	"@code-yeongyu/senpi-telemetry",
	"@code-yeongyu/senpi-codemode",
	"@code-yeongyu/senpi",
];
const VENDORED_ONLY_WORKSPACES = ["@earendil-works/pi-client", "@earendil-works/pi-protocol"];
const VENDORED_FILES = ["pi-client", "pi-protocol"].flatMap((name) =>
	["index.js", "index.d.ts"].map((file) => ({ path: `package/vendor/${name}/${file}` })),
);

let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function runtimeDependencies(manifest) {
	return Object.entries({ ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) });
}

describe("npm publish dependency graph", () => {
	it("keeps upstream workspaces private and publishes owned registry aliases", () => {
		// Given: the fork publishes its workspaces under @code-yeongyu names; the upstream
		// source names stay private and are reached only through those aliases.
		const publishedNames = getPublicWorkspacePackages().map(({ name }) => name);
		assert.equal(readJson(join(repoRoot, "packages/server/package.json")).private, true);
		assert.ok(!publishedNames.includes("@code-yeongyu/senpi-server"));

		for (const workspace of PRIVATE_UPSTREAM_WORKSPACES) {
			const manifest = readJson(join(repoRoot, workspace.packageJsonPath));
			assert.equal(manifest.private, true, `${workspace.packageName} must remain private`);
		}
		// Every registry source manifest stays private; the fork publishes it only under its alias.
		const workspaceManifests = findPackageDirectories("packages").map((directory) => readJson(join(repoRoot, directory, "package.json")));
		for (const packageName of registrySourcePackageNames) {
			const manifest = workspaceManifests.find(({ name }) => name === packageName);
			assert.ok(manifest, `${packageName} must be a workspace`);
			assert.equal(manifest.private, true, `${packageName} must remain private`);
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
		for (const packageName of VENDORED_ONLY_WORKSPACES) {
			assert.ok(!publishedNames.includes(packageName));
		}
	});

	it("reaches every in-repo workspace a published package declares through a resolvable registry edge", () => {
		// Given: npm and bun resolve every declared edge of every published manifest from the
		// registry. An in-repo workspace is installable only when it is published under a fork
		// alias, or left on upstream's own release line so its declared range matches an upstream
		// version. CalVer-stamping a workspace the fork does not publish produces a spec nothing
		// can satisfy (issue #1632: chord shipped that way in 2026.9.12-3), and the never-published
		// client/protocol exist only as senpi's vendored copies.
		const publishedNames = getPublicWorkspacePackages().map(({ name }) => name);
		const workspaces = findPackageDirectories().map((directory) => ({
			directory,
			manifest: readJson(join(directory, "package.json")),
		}));
		const problems = [];
		for (const { manifest: dependent } of workspaces.filter(({ manifest }) => registrySourcePackageNames.has(manifest.name))) {
			for (const [packageName, range] of runtimeDependencies(dependent)) {
				const source = workspaces.find(({ manifest }) => manifest.name === packageName);
				if (!source) continue;
				if (VENDORED_ONLY_WORKSPACES.includes(packageName)) {
					if (dependent.name !== "@code-yeongyu/senpi") {
						problems.push(`${dependent.name} declares ${packageName}, which is vendored into senpi only`);
					}
					continue;
				}
				const registryName = registryPackageNames.get(packageName);
				if (registryName !== undefined) {
					if (!publishedNames.includes(registryName)) {
						problems.push(`${packageName}: mapped to ${registryName} but that alias is not published`);
					}
					continue;
				}
				const relativeManifest = `${relative(repoRoot, source.directory)}/package.json`.replaceAll("\\", "/");
				if (WORKSPACE_PACKAGES.includes(relativeManifest)) {
					problems.push(`${packageName}: CalVer-stamped through ${relativeManifest} without a published fork alias`);
				}
				// The install-lock must resolve a non-aliased workspace's closure from its local
				// manifest instead of fetching upstream registry metadata for a different version.
				if (!BUNDLED_INTERNAL_WORKSPACES.includes(relativeManifest)) {
					problems.push(`${packageName}: declared without a fork alias but not listed in BUNDLED_INTERNAL_WORKSPACES`);
				}
				if (!semver.satisfies(source.manifest.version, range)) {
					problems.push(`${dependent.name} declares ${packageName}@${range}, which ${source.manifest.version} does not satisfy`);
				}
			}
		}
		assert.deepEqual(problems, [], problems.join("; "));
	});

	it("stages the real senpi manifest as its source dependencies minus the vendored ones, through aliases", () => {
		// Given: a copy of the checked-in coding-agent manifest.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-real-manifest-"));
		const sourcePath = join(repoRoot, "packages/coding-agent/package.json");
		const source = readJson(sourcePath);
		mkdirSync(join(tempDir, "packages/coding-agent"), { recursive: true });
		copyFileSync(sourcePath, join(tempDir, "packages/coding-agent/package.json"));

		// When
		const staged = stagePublishManifest(tempDir);

		// Then: the same keys minus client/protocol, fork workspaces pinned to the lockstep
		// version through their alias, and every other edge untouched.
		assert.equal(Object.hasOwn(source, "bundleDependencies"), false);
		assert.equal(Object.hasOwn(staged, "bundleDependencies"), false);
		assert.equal(Object.hasOwn(staged, "bundledDependencies"), false);
		for (const field of ["dependencies", "optionalDependencies"]) {
			const expected = Object.fromEntries(
				Object.entries(source[field] ?? {})
					.filter(([name]) => !VENDORED_ONLY_WORKSPACES.includes(name))
					.map(([name, spec]) => {
						if (ownedRegistryAliases.has(name)) return [name, `npm:${ownedRegistryAliases.get(name)}@${source.version}`];
						if (name === "@code-yeongyu/senpi-codemode") return [name, source.version];
						return [name, spec];
					}),
			);
			assert.deepEqual(staged[field] ?? {}, expected, field);
		}
		assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles({ files: VENDORED_FILES }, staged));
	});
});
