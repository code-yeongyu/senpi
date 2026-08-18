#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteOwnedRegistryAliases, stagePublishManifest } from "./prepare-senpi-publish-manifest.mjs";
import { pinSenpiPeerDependency } from "./publish-manifest.mjs";
export {
	bundlablePublishPackageNames,
	isPlatformConstrainedPackage,
	listStagedPublishPackageNames,
	ownedRegistryAliases,
	rewriteOwnedRegistryAliases,
	stagePublishManifest,
} from "./prepare-senpi-publish-manifest.mjs";

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
		source: "packages/telemetry",
		packageName: "@earendil-works/pi-telemetry",
		targetParts: ["@earendil-works", "pi-telemetry"],
		sourceOnly: false,
	},
	{
		source: "packages/senpi-codemode",
		packageName: "@code-yeongyu/senpi-codemode",
		targetParts: ["@code-yeongyu", "senpi-codemode"],
		sourceOnly: true,
		requiredFiles: ["package.json", "src/index.ts", "src/kernels/py/prelude.py"],
	},
];
const vendoredTypeWorkspaces = [
	{
		source: "packages/client/dist",
		packageName: "@earendil-works/pi-client",
		target: "pi-client",
		resolverParts: ["@earendil-works", "pi-client"],
		requiredFiles: ["index.js", "index.d.ts"],
	},
	{
		source: "packages/protocol/dist",
		packageName: "@earendil-works/pi-protocol",
		target: "pi-protocol",
		resolverParts: ["@earendil-works", "pi-protocol"],
		requiredFiles: ["index.js", "index.d.ts"],
	},
];
const internalPackageNames = new Set([...bundledWorkspaces, ...vendoredTypeWorkspaces].map((workspace) => workspace.packageName));
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

function vendoredWorkspacePackageChecks() {
	return vendoredTypeWorkspaces.map((workspace) => ({
		packageName: workspace.packageName,
		target: workspace.target,
		requiredFiles: workspace.requiredFiles,
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

function listFilesRecursive(rootDir) {
	const files = [];
	const pending = [rootDir];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
			} else {
				files.push(path);
			}
		}
	}
	return files;
}

function relativeModuleSpecifier(fromFile, toFile) {
	const path = relative(dirname(fromFile), toFile).replaceAll("\\", "/");
	return path.startsWith(".") ? path : `./${path}`;
}

function rewritePackageSpecifier(rootDir, packageName, targetFile) {
	if (!existsSync(rootDir)) return;
	for (const path of listFilesRecursive(rootDir)) {
		if (!path.endsWith(".js") && !path.endsWith(".d.ts")) continue;
		const source = readFileSync(path, "utf8");
		const specifier = relativeModuleSpecifier(path, targetFile);
		const rewritten = source
			.replaceAll(`"${packageName}"`, `"${specifier}"`)
			.replaceAll(`'${packageName}'`, `'${specifier}'`);
		if (rewritten !== source) {
			writeFileSync(path, rewritten);
		}
	}
}

function assertNoVendoredPackageSpecifiers(rootDirs) {
	for (const rootDir of rootDirs) {
		if (!existsSync(rootDir)) continue;
		for (const path of listFilesRecursive(rootDir)) {
			if (!path.endsWith(".js") && !path.endsWith(".d.ts")) continue;
			const source = readFileSync(path, "utf8");
			for (const workspace of vendoredTypeWorkspaces) {
				if (source.includes(workspace.packageName)) {
					throw new Error(
						`Vendored output ${path} still references resolver-visible package ${workspace.packageName}`,
					);
				}
			}
		}
	}
}

function rewriteBundledWorkspaceManifest(targetRoot) {
	const manifestPath = join(targetRoot, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	rewriteOwnedRegistryAliases(manifest);
	pinSenpiPeerDependency(manifest);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, "\t")}\n`);
}

function assertVendoredRuntimeDependencies(repoRoot) {
	const codingAgentManifest = JSON.parse(
		readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"),
	);
	const codingAgentRuntimeDependencies = {
		...(codingAgentManifest.dependencies ?? {}),
		...(codingAgentManifest.optionalDependencies ?? {}),
	};
	const vendoredPackageNames = new Set(vendoredTypeWorkspaces.map((workspace) => workspace.packageName));
	for (const workspace of vendoredTypeWorkspaces) {
		const manifest = JSON.parse(readFileSync(join(repoRoot, dirname(workspace.source), "package.json"), "utf8"));
		for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
			if (vendoredPackageNames.has(dependencyName)) continue;
			if (codingAgentRuntimeDependencies[dependencyName] === undefined) {
				throw new Error(
					`Vendored workspace ${workspace.packageName} requires ${dependencyName}, which is absent from @code-yeongyu/senpi runtime dependencies`,
				);
			}
		}
	}
}

function copyVendoredTypeWorkspaces(repoRoot) {
	const codingAgentDir = join(repoRoot, "packages/coding-agent");
	const codingAgentNodeModules = join(codingAgentDir, "node_modules");
	const vendorRoot = join(codingAgentDir, "vendor");
	rmSync(vendorRoot, { recursive: true, force: true });
	assertVendoredRuntimeDependencies(repoRoot);

	for (const workspace of vendoredTypeWorkspaces) {
		rmSync(join(codingAgentNodeModules, ...workspace.resolverParts), { recursive: true, force: true });
		const sourceRoot = join(repoRoot, workspace.source);
		for (const requiredFile of workspace.requiredFiles) {
			const requiredPath = join(sourceRoot, requiredFile);
			if (!existsSync(requiredPath)) {
				throw new Error(`Missing ${requiredPath}. Run npm run build before preparing vendored workspaces.`);
			}
		}

		const targetRoot = join(vendorRoot, workspace.target);
		mkdirSync(dirname(targetRoot), { recursive: true });
		cpSync(sourceRoot, targetRoot, { recursive: true });
	}

	const clientRoot = join(vendorRoot, "pi-client");
	const protocolRoot = join(vendorRoot, "pi-protocol");
	rewritePackageSpecifier(clientRoot, "@earendil-works/pi-protocol", join(protocolRoot, "index.js"));
	rewritePackageSpecifier(
		join(codingAgentDir, "dist"),
		"@earendil-works/pi-client",
		join(clientRoot, "index.js"),
	);
	rewritePackageSpecifier(
		join(codingAgentDir, "dist"),
		"@earendil-works/pi-protocol",
		join(protocolRoot, "index.js"),
	);
	assertNoVendoredPackageSpecifiers([join(codingAgentDir, "dist"), vendorRoot]);
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
	const resolverVisibleVendor = [...filePaths].find(
		(path) =>
			path.includes("node_modules/@earendil-works/pi-client/") ||
			path.includes("node_modules/@earendil-works/pi-protocol/"),
	);
	if (resolverVisibleVendor) {
		throw new Error(
			`senpi package tarball must keep client/protocol outside package-manager node_modules (found ${resolverVisibleVendor})`,
		);
	}

	// Every dependency selected by the staged bundle manifest must be vendored in the
	// tarball. Platform-specific optional dependencies intentionally stay outside this
	// list so npm can resolve the matching native package on the consumer machine.
	const missingRuntimeDependencies = [];
	for (const dependencyName of options.bundledDependencies ?? options.runtimeDependencies ?? []) {
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
	for (const { target, requiredFiles } of vendoredWorkspacePackageChecks()) {
		const packageRoot = `package/vendor/${target}`;
		const dryRunPackageRoot = `vendor/${target}`;
		for (const requiredFile of requiredFiles) {
			const path = `${packageRoot}/${requiredFile}`;
			const dryRunPath = `${dryRunPackageRoot}/${requiredFile}`;
			if (!filePaths.has(path) && !filePaths.has(dryRunPath)) {
				missing.push(`${path} or ${dryRunPath}`);
			}
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
		rewriteBundledWorkspaceManifest(targetRoot);
	}

	copyVendoredTypeWorkspaces(repoRoot);

	// Rewrite the publish manifest LAST: bundleDependencies must mirror the staged
	// node_modules exactly (all registry runtime deps + the 5 workspace packages), so
	// npm pack vendors the complete runtime closure into the tarball. Publish staging
	// dirties packages/coding-agent/package.json and rewrites emitted dist imports;
	// release checkouts are disposable, while local validation must restore the checked
	// manifest and rebuild coding-agent before returning to development.
	const stagedPackageNames = stagePublishManifest(repoRoot);
	console.log(`Staged ${stagedPackageNames.length} bundled packages for @code-yeongyu/senpi publish.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	prepareSenpiBundledWorkspaces();
}
