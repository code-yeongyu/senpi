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

type PackageJson = {
	readonly name: string;
	readonly version: string;
	readonly dependencies: Readonly<Record<string, string>>;
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

	return { name: json.name, version: json.version, dependencies };
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
		const lockfile = readFileSync(join(WORKSPACE_ROOT, "package-lock.json"), "utf8");

		// When
		const nestedRegistryPackagePattern =
			/"packages\/coding-agent\/node_modules\/@earendil-works\/pi-(?:agent-core|ai|tui)"/;

		// Then
		expect(lockfile).not.toMatch(nestedRegistryPackagePattern);
	});
});
