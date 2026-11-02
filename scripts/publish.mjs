#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSenpiBundledWorkspaces } from "./prepare-senpi-bundled-workspaces.mjs";
import { rewriteOwnedRegistryAliases } from "./prepare-senpi-publish-manifest.mjs";
import { buildPublishArgs } from "./publish-command.mjs";
import { rewritePublishManifest } from "./publish-manifest.mjs";
import { parseNpmPackJson } from "./npm-pack-json.mjs";
import { assertPublishedWorkspacePackFiles, assertSenpiPackedWorkspaceFiles } from "./senpi-publish-pack-checks.mjs";
import { queryNpmRegistry } from "./npm-registry.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { registryPackageNames } from "./registry-packages.mjs";

// Source packages retain their upstream names and private guard. Registry-backed
// packages are published from temporary manifests under our scope, while bundled-only
// client/protocol imports keep their original @earendil-works keys in the Senpi tarball.
//
// @code-yeongyu/senpi-server remains excluded because it is `private: true`, and
// The sqlite session backend keeps upstream's independent semver line.
const publishOrder = [...registryPackageNames.values()];
const packages = getPublicWorkspacePackages()
	.sort((a, b) => publishOrder.indexOf(a.name) - publishOrder.indexOf(b.name))
	.map((pkg) => ({ ...pkg, rewriteManifest: true }));
const sourceOnlyPackages = new Set(["@code-yeongyu/senpi-codemode"]);
const temporaryPublishDirectories = [];

const dryRun = process.argv.includes("--dry-run");
const requiredNativePrebuildFlag = "--require-native-prebuilds=";
const legacyRequiredNativePrebuildFlag = "--require-native-prebuild=";
// The publish-only job of publish-npm.yml explicitly names every non-best-effort
// target; the required set is validated against SUPPORTED_NATIVE_PREBUILD_TARGETS by
// the pack check itself (senpi#1193).
const requiredNativePrebuildTargets = process.argv
	.slice(2)
	.filter(
		(arg) =>
			arg.startsWith(requiredNativePrebuildFlag) || arg.startsWith(legacyRequiredNativePrebuildFlag),
	)
	.flatMap((arg) => arg.slice(arg.indexOf("=") + 1).split(","))
	.map((target) => target.trim())
	.filter((target) => target.length > 0);
const unknownArgs = process.argv
	.slice(2)
	.filter(
		(arg) =>
			arg !== "--dry-run" &&
			!arg.startsWith(requiredNativePrebuildFlag) &&
			!arg.startsWith(legacyRequiredNativePrebuildFlag),
	);

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run] [--require-native-prebuilds=<platform>-<arch>[,...]]`);
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
	rewritePublishManifest(manifest, {
		directory: pkg.directory,
		name: pkg.name,
	});
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

function validatePack(pkg) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: pkg.publishDirectory });
	const packed = parseNpmPackJson(result.stdout)[0];
	if (pkg.directory === "packages/coding-agent") {
		assertSenpiPackedWorkspaceFiles(packed, readPackageJson(pkg.publishDirectory));
	} else {
		assertPublishedWorkspacePackFiles(packed, readPackageJson(pkg.directory).name, { requiredNativePrebuildTargets });
	}
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	return queryNpmRegistry(`${name}@${version}`, "version") !== null;
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

const publishArgs = dryRun ? undefined : buildPublishArgs({ githubActions: process.env.GITHUB_ACTIONS === "true" });

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
	validatePack(pkg);
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

		run("npm", publishArgs, {
			cwd: pkg.publishDirectory,
		});
		console.log();
	}
} finally {
	removeTemporaryPublishDirectories();
}
