import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isUnpublishedForkPackage, registryPackageNames } from "./registry-packages.mjs";

export const ownedRegistryAliases = new Map(
	[...registryPackageNames].filter(([sourceName, registryName]) => sourceName !== registryName),
);
const ownedRegistryPackageNames = new Set([...ownedRegistryAliases.values(), "@code-yeongyu/senpi-codemode"]);
const vendoredOnlyPackageNames = ["@earendil-works/pi-client", "@earendil-works/pi-protocol"];
const runtimeDependencyFields = ["dependencies", "optionalDependencies"];

function exactVersionSpec(spec) {
	const exact = spec.replace(/^[~^]/, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(exact)) {
		throw new Error(`Internal publish dependency must use an exact version, received ${spec}`);
	}
	return exact;
}

export function rewriteOwnedRegistryAliases(manifest) {
	for (const dependencyField of runtimeDependencyFields) {
		const dependencies = manifest[dependencyField];
		if (!dependencies) {
			continue;
		}
		for (const [packageName, aliasName] of ownedRegistryAliases) {
			const version = dependencies[packageName];
			if (typeof version === "string" && !version.startsWith("npm:")) {
				dependencies[packageName] = `npm:${aliasName}@${exactVersionSpec(version)}`;
			}
		}
		for (const [packageName, version] of Object.entries(dependencies)) {
			if (ownedRegistryPackageNames.has(packageName) && typeof version === "string" && !version.startsWith("npm:")) {
				dependencies[packageName] = exactVersionSpec(version);
			}
		}
	}
	return manifest;
}

function prepareVendoredPublishManifest(manifest) {
	for (const dependencyField of runtimeDependencyFields) {
		const dependencies = manifest[dependencyField];
		if (!dependencies) continue;
		for (const packageName of vendoredOnlyPackageNames) {
			delete dependencies[packageName];
		}
	}
	if (!Array.isArray(manifest.files)) {
		throw new Error("@code-yeongyu/senpi publish manifest must declare files before adding vendor output");
	}
	manifest.files = [...new Set([...manifest.files, "vendor"])];
}

// The published manifest is the source dependency list, not a flattened copy of the
// runtime closure. Every fork workspace is published under its own @code-yeongyu name
// (scripts/registry-packages.mjs) and reached through an exact `npm:` alias, so npm and
// bun resolve the whole graph from the registry. The only packages that ship inside the
// tarball are the unpublished client/protocol workspaces, vendored under `vendor/` by
// prepare-senpi-bundled-workspaces.mjs. Platform binaries stay optional edges of the
// packages that own them, which resolve the installing machine's native package.
export function stagePublishManifest(repoRoot) {
	const manifestPath = join(repoRoot, "packages/coding-agent/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	prepareVendoredPublishManifest(manifest);
	for (const field of runtimeDependencyFields) {
		for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
			if (/^(file|link|workspace):/.test(spec)) {
				throw new Error(
					`packages/coding-agent/package.json ${field}.${name} uses a local spec (${spec}); the published tarball must not reference local paths.`,
				);
			}
		}
	}
	const unpublished = runtimeDependencyFields
		.flatMap((field) => Object.keys(manifest[field] ?? {}))
		.filter(isUnpublishedForkPackage);
	if (unpublished.length > 0) {
		throw new Error(
			`@code-yeongyu/senpi declares packages that are never published, which no registry install can resolve (senpi#2141): ${unpublished.join(", ")}`,
		);
	}
	delete manifest.bundleDependencies;
	delete manifest.bundledDependencies;
	rewriteOwnedRegistryAliases(manifest);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}
