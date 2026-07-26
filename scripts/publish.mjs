#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSenpiPackedWorkspaceFiles,
	prepareSenpiBundledWorkspaces,
	rewriteOwnedRegistryAliases,
} from "./prepare-senpi-bundled-workspaces.mjs";

// Source packages retain their upstream names and private guard. Each is published
// from a temporary manifest under our scope, while every source import continues to
// resolve through the original @earendil-works key and its owned npm alias.
//
// @code-yeongyu/senpi-server remains excluded because it is `private: true`, and
// @earendil-works/pi-storage-sqlite-node keeps upstream's independent semver line.
const packages = [
	{ directory: "packages/ai", name: "@code-yeongyu/senpi-ai", rewriteManifest: true },
	{ directory: "packages/agent", name: "@code-yeongyu/senpi-agent-core", rewriteManifest: true },
	{ directory: "packages/tui", name: "@code-yeongyu/senpi-tui", rewriteManifest: true },
	{ directory: "packages/pty", name: "@code-yeongyu/senpi-pty", rewriteManifest: true },
	{ directory: "packages/senpi-codemode", name: "@code-yeongyu/senpi-codemode", rewriteManifest: true },
	{ directory: "packages/coding-agent", name: "@code-yeongyu/senpi" },
];
const sourceOnlyPackages = new Set(["@code-yeongyu/senpi-codemode"]);
const temporaryPublishDirectories = [];

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function stagePublishDirectory(pkg) {
	if (!pkg.rewriteManifest) {
		return pkg.directory;
	}

	const temporaryRoot = mkdtempSync(join(tmpdir(), "senpi-publish-"));
	const directory = join(temporaryRoot, "package");
	cpSync(pkg.directory, directory, { recursive: true });
	const manifestPath = join(directory, "package.json");
	const manifest = readPackageJson(directory);
	manifest.name = pkg.name;
	delete manifest.private;
	rewriteOwnedRegistryAliases(manifest);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	temporaryPublishDirectories.push(temporaryRoot);
	return directory;
}

function removeTemporaryPublishDirectories() {
	for (const directory of temporaryPublishDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
}

function assertBuildOutputExists(directory) {
	const packageJson = readPackageJson(directory);
	if (!sourceOnlyPackages.has(packageJson.name) && !existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	const packageJson = readPackageJson(directory);
	if (directory === "packages/coding-agent") {
		assertSenpiPackedWorkspaceFiles(packed, {
			runtimeDependencies: [
				...Object.keys(packageJson.dependencies ?? {}),
				...Object.keys(packageJson.optionalDependencies ?? {}),
			],
		});
	}
	if (sourceOnlyPackages.has(packageJson.name)) {
		const filePaths = new Set((packed.files ?? []).map((file) => file.path));
		// `npm pack --json` file paths vary by npm version: some emit a `package/` prefix,
		// others emit bare repo-relative paths. Accept either so the source-only content
		// check is npm-version-agnostic (mirrors assertSenpiPackedWorkspaceFiles).
		for (const requiredFile of ["src/index.ts", "README.md", "CHANGELOG.md", "LICENSE"]) {
			if (!filePaths.has(`package/${requiredFile}`) && !filePaths.has(requiredFile)) {
				throw new Error(`${packageJson.name} package tarball is missing ${requiredFile}`);
			}
		}
	}
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const packageVersions = new Map();
for (const pkg of packages) {
	const packageJson = readPackageJson(pkg.directory);
	if (!pkg.rewriteManifest && packageJson.name !== pkg.name) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
	}
	packageVersions.set(pkg.name, packageJson.version);
}

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(`Publishing senpi packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

prepareSenpiBundledWorkspaces();

const packageStates = packages.map((pkg) => ({
	...pkg,
	publishDirectory: stagePublishDirectory(pkg),
	published: false,
	version: packageVersions.get(pkg.name),
}));

for (const pkg of packageStates) {
	assertBuildOutputExists(pkg.directory);
	pkg.published = isPublished(pkg.name, pkg.version);

	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} is already published; validating package contents only.`);
	} else {
		console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
	}
	validatePack(pkg.publishDirectory);
	console.log();
}

if (dryRun) {
	removeTemporaryPublishDirectories();
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

try {
	for (const pkg of packageStates) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
			continue;
		}

		run("npm", ["publish", "--access", "public", "--tag", "latest", "--provenance", "--ignore-scripts"], {
			cwd: pkg.publishDirectory,
		});
		console.log();
	}
} finally {
	removeTemporaryPublishDirectories();
}
