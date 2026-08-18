import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registryPackageNames } from "./registry-packages.mjs";

export const ownedRegistryAliases = new Map(
	[...registryPackageNames].filter(([sourceName, registryName]) => sourceName !== registryName),
);
const ownedRegistryPackageNames = new Set([...ownedRegistryAliases.values(), "@code-yeongyu/senpi-codemode"]);
const vendoredOnlyPackageNames = ["@earendil-works/pi-client", "@earendil-works/pi-protocol"];

function exactVersionSpec(spec) {
	const exact = spec.replace(/^[~^]/, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(exact)) {
		throw new Error(`Internal publish dependency must use an exact version, received ${spec}`);
	}
	return exact;
}

export function rewriteOwnedRegistryAliases(manifest) {
	for (const dependencyField of ["dependencies", "optionalDependencies"]) {
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
	for (const dependencyField of ["dependencies", "optionalDependencies"]) {
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

export function listStagedPublishPackageNames(codingAgentNodeModules) {
	const packageNames = [];
	for (const entry of readdirSync(codingAgentNodeModules, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) {
			continue;
		}
		if (entry.name.startsWith("@")) {
			const scopeDir = join(codingAgentNodeModules, entry.name);
			for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
				if (scoped.isDirectory()) {
					packageNames.push(`${entry.name}/${scoped.name}`);
				}
			}
			continue;
		}
		packageNames.push(entry.name);
	}
	return packageNames.sort((a, b) => a.localeCompare(b));
}

// npm evaluates `os`/`cpu`/`libc` against the INSTALLING machine, but bundleDependencies ships a
// single tarball to every platform and npm republishes the bundled set as required `dependencies`
// in the registry manifest. Bundling a native binary that only matches the publish runner
// (linux-x64 in publish-npm.yml) therefore aborts `npm install @code-yeongyu/senpi` with
// EBADPLATFORM on every other platform, before a single file is written. Such packages stay
// ordinary optional registry deps: npm resolves the binary matching the installing platform, and
// a failed fetch degrades the feature instead of failing the install.
function readPackageManifest(packageDir) {
	try {
		return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
}

export function isPlatformConstrainedPackage(packageDir) {
	const manifest = readPackageManifest(packageDir);
	// An unreadable staged package cannot be judged here; leave it bundled so the existing
	// staging and pack gates report it instead of this filter dropping it silently.
	if (!manifest) return false;
	return ["os", "cpu", "libc"].some((field) => {
		// npm accepts a bare string as well as the documented array form.
		const constraint = manifest[field];
		if (typeof constraint === "string") {
			return constraint.length > 0;
		}
		return Array.isArray(constraint) && constraint.length > 0;
	});
}

export function bundlablePublishPackageNames(codingAgentNodeModules, packageNames) {
	return packageNames.filter((name) => !isPlatformConstrainedPackage(join(codingAgentNodeModules, name)));
}

function promotePlatformOptionalDependencyFamilies(codingAgentNodeModules, packageNames) {
	const promoted = {};
	for (const packageName of packageNames) {
		const packageDir = join(codingAgentNodeModules, packageName);
		const manifest = readPackageManifest(packageDir);
		if (!manifest) continue;
		const optionalDependencies = manifest.optionalDependencies ?? {};
		const materializedOptionalNames = Object.keys(optionalDependencies).filter((name) =>
			existsSync(join(codingAgentNodeModules, name)),
		);
		if (
			!materializedOptionalNames.some((name) =>
				isPlatformConstrainedPackage(join(codingAgentNodeModules, name)),
			)
		) {
			continue;
		}
		Object.assign(promoted, optionalDependencies);
		// npm treats optional edges owned by a bundled package as already satisfied by
		// the bundle and only creates empty package directories. The promoted root edges
		// must be the sole owners so npm fetches the consumer platform's real sidecar.
		manifest.optionalDependencies = {};
		writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	}
	return promoted;
}

// The publish tarball must be fully self-contained: every runtime dependency edge in
// the coding-agent manifest (registry deps AND the 5 vendored workspace packages) is
// staged into packages/coding-agent/node_modules, and bundleDependencies lists every
// portable staged package (platform-constrained natives are excluded — see
// isPlatformConstrainedPackage). npm then needs no registry fetch for anything that
// installs identically on every platform at install time. The historical
// partial bundle (only the 5 workspace packages + their closure) forced npm to fetch
// the other runtime deps from the registry, where arborist nondeterministically tried
// to resolve the registry-absent `^2026.x` workspace specs (ETARGET) and aborted reify
// mid-flight, leaving arbitrary deps (cross-spawn, which, @modelcontextprotocol/sdk)
// missing from the installed CLI (ERR_MODULE_NOT_FOUND).
export function stagePublishManifest(repoRoot) {
	const codingAgentDir = join(repoRoot, "packages/coding-agent");
	const manifestPath = join(codingAgentDir, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const codingAgentNodeModules = join(codingAgentDir, "node_modules");
	const stagedPackageNames = listStagedPublishPackageNames(codingAgentNodeModules);
	const stagedSet = new Set(stagedPackageNames);
	prepareVendoredPublishManifest(manifest);

	const runtimeDependencyFields = ["dependencies", "optionalDependencies"];
	const missing = [];
	for (const field of runtimeDependencyFields) {
		for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
			if (/^(file|link|workspace):/.test(spec)) {
				throw new Error(
					`packages/coding-agent/package.json ${field}.${name} uses a local spec (${spec}); the published tarball must not reference local paths.`,
				);
			}
			if (!stagedSet.has(name)) {
				missing.push(name);
			}
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`packages/coding-agent/node_modules is missing staged runtime dependencies: ${missing.join(", ")}. Run npm install before publishing.`,
		);
	}

	const bundlablePackageNames = bundlablePublishPackageNames(codingAgentNodeModules, stagedPackageNames);
	manifest.optionalDependencies = {
		...promotePlatformOptionalDependencyFamilies(codingAgentNodeModules, stagedPackageNames),
		...(manifest.optionalDependencies ?? {}),
	};
	manifest.dependencies ??= {};
	for (const packageName of bundlablePackageNames) {
		if (manifest.dependencies[packageName] !== undefined || manifest.optionalDependencies[packageName] !== undefined) {
			continue;
		}
		const packageManifest = readPackageManifest(join(codingAgentNodeModules, packageName));
		if (typeof packageManifest?.version !== "string") {
			throw new Error(`Bundled runtime package ${packageName} must declare an exact version`);
		}
		manifest.dependencies[packageName] = packageManifest.version;
	}
	const bundlableSet = new Set(bundlablePackageNames);
	for (const packageName of stagedPackageNames) {
		if (!bundlableSet.has(packageName)) {
			rmSync(join(codingAgentNodeModules, packageName), { recursive: true, force: true });
		}
	}
	// Keep the original dependency keys so npm packs the modules at the import paths
	// the compiled source uses. Resolve those keys through fork-owned aliases instead
	// of attempting to fetch lockstep versions from the upstream-owned namespace.
	rewriteOwnedRegistryAliases(manifest);
	manifest.bundleDependencies = bundlablePackageNames;
	// npm accepts both spellings; the checked-in manifest carries both, so keep them in sync.
	if (manifest.bundledDependencies !== undefined) {
		manifest.bundledDependencies = [...bundlablePackageNames];
	}
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return bundlablePackageNames;
}
