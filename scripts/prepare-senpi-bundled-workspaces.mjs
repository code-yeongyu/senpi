#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePublishManifest } from "./prepare-senpi-publish-manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// The client/protocol workspaces are never published, so their built output is vendored
// under `vendor/` inside the senpi tarball, outside package-manager `node_modules`, and
// every emitted import of them is rewritten to a relative path.
const vendoredTypeWorkspaces = [
	{
		source: "packages/client/dist",
		packageName: "@earendil-works/pi-client",
		target: "pi-client",
		requiredFiles: ["index.js", "index.d.ts"],
	},
	{
		source: "packages/protocol/dist",
		packageName: "@earendil-works/pi-protocol",
		target: "pi-protocol",
		requiredFiles: ["index.js", "index.d.ts"],
	},
];

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

// Vendored code is not a package, so its registry dependencies must be declared by senpi.
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
	const vendorRoot = join(codingAgentDir, "vendor");
	rmSync(vendorRoot, { recursive: true, force: true });
	assertVendoredRuntimeDependencies(repoRoot);

	for (const workspace of vendoredTypeWorkspaces) {
		const sourceRoot = join(repoRoot, workspace.source);
		for (const requiredFile of workspace.requiredFiles) {
			const requiredPath = join(sourceRoot, requiredFile);
			if (!existsSync(requiredPath)) {
				throw new Error(`Missing ${requiredPath}. Run npm run build before preparing vendored workspaces.`);
			}
		}

		const targetRoot = join(vendorRoot, workspace.target);
		mkdirSync(dirname(targetRoot), { recursive: true });
		// Sourcemaps point at workspace sources that are not published; they never ship.
		cpSync(sourceRoot, targetRoot, { recursive: true, filter: (path) => !path.endsWith(".map") });
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

// Publish staging dirties packages/coding-agent/package.json and rewrites emitted dist
// imports; release checkouts are disposable, while local validation must restore the
// checked manifest and rebuild coding-agent before returning to development.
export function prepareSenpiBundledWorkspaces(repoRoot = root) {
	copyVendoredTypeWorkspaces(repoRoot);
	const manifest = stagePublishManifest(repoRoot);
	const dependencyCount = Object.keys(manifest.dependencies ?? {}).length;
	console.log(`Staged @code-yeongyu/senpi publish manifest with ${dependencyCount} registry dependencies.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	prepareSenpiBundledWorkspaces();
}
