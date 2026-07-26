#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const SUPPORTED_NATIVE_PREBUILD_TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
];

export function nativePrebuildTarget(platform = process.platform, arch = process.arch) {
	const target = `${platform}-${arch}`;
	if (!SUPPORTED_NATIVE_PREBUILD_TARGETS.includes(target)) {
		throw new Error(`Unsupported native prebuild target: ${target}`);
	}
	return target;
}

export function nativePrebuildFile(target) {
	return `native/prebuilds/${target}/senpi_pty.${target}.node`;
}

const bundledWorkspaces = [
	{ source: "packages/agent", packageName: "@earendil-works/pi-agent-core", targetParts: ["@earendil-works", "pi-agent-core"], sourceOnly: false },
	{ source: "packages/ai", packageName: "@earendil-works/pi-ai", targetParts: ["@earendil-works", "pi-ai"], sourceOnly: false },
	{
		source: "packages/pty",
		packageName: "@earendil-works/pi-pty",
		targetParts: ["@earendil-works", "pi-pty"],
		sourceOnly: false,
		requiredFiles: ["package.json", "dist/index.js", "native/index.js"],
		nativePrebuild: true,
	},
	{ source: "packages/tui", packageName: "@earendil-works/pi-tui", targetParts: ["@earendil-works", "pi-tui"], sourceOnly: false },
	{
		source: "packages/senpi-codemode",
		packageName: "@code-yeongyu/senpi-codemode",
		targetParts: ["@code-yeongyu", "senpi-codemode"],
		sourceOnly: true,
		requiredFiles: ["package.json", "src/index.ts", "src/kernels/py/prelude.py"],
	},
];
const internalPackageNames = new Set(bundledWorkspaces.map((workspace) => workspace.packageName));
export const ownedRegistryAliases = new Map([
	["@earendil-works/pi-ai", "@code-yeongyu/senpi-ai"],
	["@earendil-works/pi-agent-core", "@code-yeongyu/senpi-agent-core"],
	["@earendil-works/pi-tui", "@code-yeongyu/senpi-tui"],
	["@earendil-works/pi-pty", "@code-yeongyu/senpi-pty"],
]);

export function rewriteOwnedRegistryAliases(manifest) {
	for (const dependencyField of ["dependencies", "optionalDependencies"]) {
		const dependencies = manifest[dependencyField];
		if (!dependencies) {
			continue;
		}
		for (const [packageName, aliasName] of ownedRegistryAliases) {
			const version = dependencies[packageName];
			if (typeof version === "string" && !version.startsWith("npm:")) {
				dependencies[packageName] = `npm:${aliasName}@${version}`;
			}
		}
	}
	return manifest;
}

function requiredFilesForWorkspace(workspace, nativeTargets) {
	const requiredFiles = [...(workspace.requiredFiles ?? ["package.json", "dist/index.js"])];
	if (workspace.nativePrebuild) {
		requiredFiles.push(...nativeTargets.map(nativePrebuildFile));
	}
	return requiredFiles;
}

export function bundledWorkspacePackageChecks(nativeTargets = [nativePrebuildTarget()]) {
	return bundledWorkspaces.map((workspace) => ({
		packageName: workspace.packageName,
		requiredFiles: requiredFilesForWorkspace(workspace, nativeTargets),
	}));
}

function shouldCopyWorkspaceFile(sourceRoot, sourcePath, sourceOnly = false) {
	const path = relative(sourceRoot, sourcePath);
	return (
		path === "" ||
		path === "package.json" ||
		path === "README.md" ||
		path === "CHANGELOG.md" ||
		path === "LICENSE" ||
		path === "dist" ||
		path.startsWith(`dist/`) ||
		path === "native" ||
		path.startsWith(`native/`) ||
		(sourceOnly && (path === "src" || path.startsWith("src/")))
	);
}

export function directNodeModulesPackageName(lockPath) {
	if (!lockPath.startsWith("node_modules/")) {
		return undefined;
	}

	const parts = lockPath.slice("node_modules/".length).split("/");
	if (parts[0]?.startsWith("@")) {
		return parts.length === 2 ? `${parts[0]}/${parts[1]}` : undefined;
	}
	return parts.length === 1 ? parts[0] : undefined;
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
export function isPlatformConstrainedPackage(packageDir) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	} catch {
		// An unreadable staged package cannot be judged here; leave it bundled so the existing
		// staging and pack gates report it instead of this filter dropping it silently.
		return false;
	}
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

export function copyPublishDependencies(repoRoot) {
	// Staging manifest for the bundled publish tree. NOT npm-shrinkwrap.json: shipping a
	// file named npm-shrinkwrap.json breaks bundleDependencies installs (see the guard in
	// assertSenpiPackedWorkspaceFiles). Generated by generate-coding-agent-shrinkwrap.mjs.
	const manifestPath = join(repoRoot, "packages/coding-agent/publish-deps.lock.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const rootNodeModules = join(repoRoot, "node_modules");
	const codingAgentNodeModules = join(repoRoot, "packages/coding-agent/node_modules");

	for (const [lockPath, entry] of Object.entries(manifest.packages ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		const packageName = directNodeModulesPackageName(lockPath);
		if (!packageName || internalPackageNames.has(packageName)) {
			continue;
		}

		const sourcePath = join(rootNodeModules, packageName);
		if (!existsSync(sourcePath)) {
			if (entry && typeof entry === "object" && entry.optional === true) {
				continue;
			}
			throw new Error(`Missing ${sourcePath}. Run npm install before publishing.`);
		}

		const targetPath = join(codingAgentNodeModules, packageName);
		rmSync(targetPath, { recursive: true, force: true });
		mkdirSync(dirname(targetPath), { recursive: true });
		cpSync(sourcePath, targetPath, { recursive: true });
	}
}

export function assertSenpiPackedWorkspaceFiles(packed, options = {}) {
	const nativeTargets = options.nativePrebuildTargets ?? [nativePrebuildTarget()];
	const prebuildFiles = new Set(nativeTargets.map(nativePrebuildFile));
	const filePaths = new Set((packed.files ?? []).map((file) => file.path));

	// Every runtime dependency of the publish manifest must be vendored in the tarball.
	// npm only packs node_modules entries reachable from bundleDependencies, so a dep
	// missing here means it would be fetched from the registry at install time — the
	// exact failure mode (nondeterministic ERR_MODULE_NOT_FOUND) the full bundle removes.
	const missingRuntimeDependencies = [];
	for (const dependencyName of options.runtimeDependencies ?? []) {
		const packageJsonPath = `node_modules/${dependencyName}/package.json`;
		if (!filePaths.has(`package/${packageJsonPath}`) && !filePaths.has(packageJsonPath)) {
			missingRuntimeDependencies.push(dependencyName);
		}
	}
	if (missingRuntimeDependencies.length > 0) {
		throw new Error(
			`senpi package tarball is missing vendored runtime dependencies: ${missingRuntimeDependencies.join(", ")}. Run scripts/prepare-senpi-bundled-workspaces.mjs before packing.`,
		);
	}

	// npm ALWAYS packs a file literally named npm-shrinkwrap.json (files[]/.npmignore
	// cannot exclude it). Shipped alongside bundleDependencies it is fatal: npm treats
	// the shrinkwrap as the complete locked tree, installs only the bundled subtree, and
	// never fetches the non-bundled direct deps (cross-spawn, @modelcontextprotocol/sdk,
	// ...), so the installed CLI dies with ERR_MODULE_NOT_FOUND. The publish manifest is
	// generated as publish-deps.lock.json instead; guard so it can never regress.
	const shippedShrinkwrap = [...filePaths].find((path) => path === "npm-shrinkwrap.json" || path.endsWith("/npm-shrinkwrap.json"));
	if (shippedShrinkwrap) {
		throw new Error(`senpi package tarball must not ship npm-shrinkwrap.json (found ${shippedShrinkwrap}); it breaks bundleDependencies installs.`);
	}
	const missing = [];

	for (const { packageName, requiredFiles } of bundledWorkspacePackageChecks(nativeTargets)) {
		const packageRoot = `package/node_modules/${packageName}`;
		const dryRunPackageRoot = `node_modules/${packageName}`;
		for (const requiredFile of requiredFiles) {
			const path = `${packageRoot}/${requiredFile}`;
			const dryRunPath = `${dryRunPackageRoot}/${requiredFile}`;
			if (filePaths.has(path) || filePaths.has(dryRunPath)) continue;
			// The platform native prebuild (.node) is optional — the pty loader falls back
			// to a child_process pipe when it is absent, so a host without a committed/built
			// prebuild (e.g. linux-x64 in the npm-publish job) must not fail the pack check.
			if (prebuildFiles.has(requiredFile)) {
				console.warn(`Warning: packed ${packageName} has no native prebuild ${requiredFile} (pipe fallback at runtime).`);
				continue;
			}
			missing.push(`${path} or ${dryRunPath}`);
		}
	}

	if (missing.length > 0) {
		throw new Error(`senpi package tarball is missing bundled workspace files: ${missing.join(", ")}`);
	}
}

export function prepareSenpiBundledWorkspaces(repoRoot = root) {
	copyPublishDependencies(repoRoot);
	const codingAgentNodeModules = join(repoRoot, "packages/coding-agent/node_modules");

	for (const workspace of bundledWorkspaces) {
		const sourceRoot = join(repoRoot, workspace.source);
		const distPath = join(sourceRoot, "dist");
		if (!workspace.sourceOnly && !existsSync(distPath)) {
			throw new Error(`Missing ${distPath}. Run npm run build before preparing bundled workspaces.`);
		}

		// Loader files (package.json, dist/index.js, native/index.js) are hard-required.
		// The platform-specific native prebuild (.node) is NOT: when it is absent the pty
		// loader uses its child_process pipe fallback (same tolerance as build-binaries.sh,
		// and the published package historically shipped with no prebuilds at all). So a
		// missing host prebuild must warn, not fail the publish on a runner whose platform
		// has no committed or built prebuild (e.g. linux-x64 in the npm-publish job).
		const prebuildFiles = new Set(workspace.nativePrebuild ? [nativePrebuildFile(nativePrebuildTarget())] : []);
		const requiredFiles = requiredFilesForWorkspace(workspace, [nativePrebuildTarget()]);
		for (const requiredFile of requiredFiles) {
			const requiredPath = join(sourceRoot, requiredFile);
			if (existsSync(requiredPath)) continue;
			if (prebuildFiles.has(requiredFile)) {
				console.warn(
					`Warning: ${workspace.packageName} has no native prebuild at ${requiredFile}; bundling without it (pipe fallback at runtime).`,
				);
				continue;
			}
			throw new Error(
				`Missing ${requiredPath}. ${workspace.packageName} cannot be bundled without loader-visible package files.`,
			);
		}

		const targetRoot = join(codingAgentNodeModules, ...workspace.targetParts);
		rmSync(targetRoot, { recursive: true, force: true });
		mkdirSync(dirname(targetRoot), { recursive: true });
		cpSync(sourceRoot, targetRoot, {
			recursive: true,
			filter: (sourcePath) => shouldCopyWorkspaceFile(sourceRoot, sourcePath, workspace.sourceOnly),
		});
	}

	// Rewrite the publish manifest LAST: bundleDependencies must mirror the staged
	// node_modules exactly (all registry runtime deps + the 5 workspace packages), so
	// npm pack vendors the complete runtime closure into the tarball. This dirties
	// packages/coding-agent/package.json in the working tree; restore it with
	// `git checkout -- packages/coding-agent/package.json` after packing/publishing.
	const stagedPackageNames = stagePublishManifest(repoRoot);
	console.log(`Staged ${stagedPackageNames.length} bundled packages for @code-yeongyu/senpi publish.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	prepareSenpiBundledWorkspaces();
}
