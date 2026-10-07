import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const WORKSPACE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const WORKSPACE_DEPENDENCIES = [
	{ name: "@earendil-works/pi-agent-core", packageJsonPath: "packages/agent/package.json" },
	{ name: "@earendil-works/pi-ai", packageJsonPath: "packages/ai/package.json" },
	{ name: "@earendil-works/pi-tui", packageJsonPath: "packages/tui/package.json" },
] as const;
// Never published: their build output is vendored into the senpi tarball under `vendor/`.
const VENDORED_WORKSPACES = [
	{ name: "@earendil-works/pi-client", packageJsonPath: "packages/client/package.json" },
	{ name: "@earendil-works/pi-protocol", packageJsonPath: "packages/protocol/package.json" },
] as const;
const VENDORED_WORKSPACE_NAMES = new Set<string>(VENDORED_WORKSPACES.map((workspace) => workspace.name));

type PackageJson = {
	readonly name: string;
	readonly version: string;
	readonly private: boolean;
	readonly dependencies: Readonly<Record<string, string>>;
	readonly optionalDependencies: Readonly<Record<string, string>>;
	readonly declaresBundleFields: boolean;
	readonly scripts: Readonly<Record<string, string>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
	if (!isRecord(parsed)) {
		throw new Error(`${filePath} must contain a JSON object`);
	}
	return parsed;
}

function readPackageJson(packageJsonPath: string): PackageJson {
	const filePath = join(WORKSPACE_ROOT, packageJsonPath);
	const json = readJsonObject(filePath);
	if (typeof json.name !== "string" || typeof json.version !== "string") {
		throw new Error(`${packageJsonPath} must include string name and version fields`);
	}
	if (json.private !== undefined && typeof json.private !== "boolean") {
		throw new Error(`${packageJsonPath} private must be a boolean`);
	}

	const dependencies: Record<string, string> = {};
	if (json.dependencies !== undefined) {
		if (!isRecord(json.dependencies)) {
			throw new Error(`${packageJsonPath} dependencies must be a JSON object`);
		}
		for (const [name, version] of Object.entries(json.dependencies)) {
			if (typeof version !== "string") {
				throw new Error(`${packageJsonPath} dependency ${name} must be a string`);
			}
			dependencies[name] = version;
		}
	}

	const optionalDependencies: Record<string, string> = {};
	if (json.optionalDependencies !== undefined) {
		if (!isRecord(json.optionalDependencies)) {
			throw new Error(`${packageJsonPath} optionalDependencies must be a JSON object`);
		}
		for (const [name, version] of Object.entries(json.optionalDependencies)) {
			if (typeof version !== "string") {
				throw new Error(`${packageJsonPath} optional dependency ${name} must be a string`);
			}
			optionalDependencies[name] = version;
		}
	}

	const declaresBundleFields = json.bundleDependencies !== undefined || json.bundledDependencies !== undefined;

	const scripts: Record<string, string> = {};
	if (json.scripts !== undefined) {
		if (!isRecord(json.scripts)) {
			throw new Error(`${packageJsonPath} scripts must be a JSON object`);
		}
		for (const [name, command] of Object.entries(json.scripts)) {
			if (typeof command === "string") {
				scripts[name] = command;
			}
		}
	}

	return {
		name: json.name,
		version: json.version,
		private: json.private ?? false,
		dependencies,
		optionalDependencies,
		declaresBundleFields,
		scripts,
	};
}

describe("coding-agent workspace dependencies", () => {
	test("uses local workspace versions for pi packages during source builds", () => {
		// Given
		const codingAgentPackage = readPackageJson("packages/coding-agent/package.json");

		// When
		const dependencyVersions = Object.fromEntries(
			WORKSPACE_DEPENDENCIES.map((dependency) => {
				const localPackage = readPackageJson(dependency.packageJsonPath);
				return [dependency.name, `^${localPackage.version}`];
			}),
		);

		// Then
		expect(codingAgentPackage.dependencies).toMatchObject(dependencyVersions);
	});

	test("does not install nested registry pi packages under coding-agent", () => {
		// Given
		const lockfile = readJsonObject(join(WORKSPACE_ROOT, "package-lock.json"));
		if (!isRecord(lockfile.packages)) {
			throw new Error("package-lock.json packages must be a JSON object");
		}

		// When
		const nestedPiEntries = Object.entries(lockfile.packages).filter(([path]) =>
			/^packages\/coding-agent\/node_modules\/@earendil-works\/pi-(?:agent-core|ai|tui|pty|telemetry|storage-sqlite-node)$/.test(
				path,
			),
		);

		// Then
		for (const [path, value] of nestedPiEntries) {
			expect(isRecord(value), path).toBe(true);
			if (!isRecord(value)) continue;
			expect(value.link, path).toBe(true);
			expect(value.resolved, path).toMatch(/^packages\//);
		}
	});

	test("declares no bundled dependencies, so pi packages resolve from the registry", () => {
		// Given
		const codingAgentPackage = readPackageJson("packages/coding-agent/package.json");

		// Then: publish staging aliases each pi package to its @code-yeongyu name; a bundle
		// field would ship a second copy of the tree beside the registry install.
		expect(codingAgentPackage.declaresBundleFields).toBe(false);
	});

	test("routes root publication through the guarded publisher", () => {
		// Given
		const rootPackage = readJsonObject(join(WORKSPACE_ROOT, "package.json"));
		if (!isRecord(rootPackage.scripts)) {
			throw new Error("package.json scripts must be a JSON object");
		}

		// When
		const publishScript = rootPackage.scripts.publish;
		const dryRunScript = rootPackage.scripts["publish:dry"];
		if (typeof publishScript !== "string" || typeof dryRunScript !== "string") {
			throw new Error("package.json publish scripts must be strings");
		}

		// Then
		expect(publishScript).toContain("scripts/publish.mjs");
		expect(dryRunScript).toContain("scripts/publish.mjs --dry-run");
		expect(readPackageJson("packages/coding-agent/package.json").private).toBe(true);
		expect(readPackageJson("packages/senpi-codemode/package.json").private).toBe(true);
	});

	test("declares the external dependencies of the vendored client and protocol", () => {
		// Given: vendored code is not a package, so only senpi's manifest can declare its imports.
		const codingAgentPackage = readPackageJson("packages/coding-agent/package.json");
		// When
		const missingExternalDependencies: string[] = [];
		for (const workspace of VENDORED_WORKSPACES) {
			const localPackage = readPackageJson(workspace.packageJsonPath);
			for (const [name, version] of Object.entries(localPackage.dependencies)) {
				if (VENDORED_WORKSPACE_NAMES.has(name)) {
					continue;
				}
				const declaredVersion =
					codingAgentPackage.dependencies[name] ?? codingAgentPackage.optionalDependencies[name];
				if (declaredVersion !== version) {
					missingExternalDependencies.push(`${name}@${version}`);
				}
			}
		}

		// Then
		expect(missingExternalDependencies).toEqual([]);
	});
});
