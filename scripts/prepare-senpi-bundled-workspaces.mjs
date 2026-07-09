#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

export function copyPublishDependencies(repoRoot) {
	const shrinkwrapPath = join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");
	const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
	const rootNodeModules = join(repoRoot, "node_modules");
	const codingAgentNodeModules = join(repoRoot, "packages/coding-agent/node_modules");

	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	prepareSenpiBundledWorkspaces();
}
