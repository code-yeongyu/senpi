#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSenpiPackedWorkspaceFiles, prepareSenpiBundledWorkspaces } from "./prepare-senpi-bundled-workspaces.mjs";

const packages = [
	{ directory: "packages/ai", name: "@earendil-works/pi-ai" },
	{ directory: "packages/agent", name: "@earendil-works/pi-agent-core" },
	{ directory: "packages/tui", name: "@earendil-works/pi-tui" },
	{ directory: "packages/orchestrator", name: "@code-yeongyu/senpi-orchestrator" },
	{ directory: "packages/senpi-codemode", name: "@code-yeongyu/senpi-codemode" },
	{ directory: "packages/coding-agent", name: "@code-yeongyu/senpi" },
];
const sourceOnlyPackages = new Set(["@code-yeongyu/senpi-codemode"]);

// The neo (Go TUI) distribution: six per-platform binary packages plus the meta
// package, staged into dist/neo-npm/ by scripts/generate-neo-npm-packages.mjs.
// Unlike the TypeScript workspaces these carry a prebuilt binary/launcher and no
// dist/ build output, so they are validated by asserting the staged bin exists
// (assertStagedBinExists) rather than a dist/ directory. They join the publish
// set only once staged; the release pipeline stages them before invoking this
// script. Staging is all-or-nothing — a partial dist/neo-npm is a hard error.
const neoPackageDir = "dist/neo-npm";
const neoPackages = [
	{ directory: `${neoPackageDir}/senpi-neo-tui-darwin-x64`, name: "@code-yeongyu/senpi-neo-tui-darwin-x64", staged: true },
	{ directory: `${neoPackageDir}/senpi-neo-tui-darwin-arm64`, name: "@code-yeongyu/senpi-neo-tui-darwin-arm64", staged: true },
	{ directory: `${neoPackageDir}/senpi-neo-tui-linux-x64`, name: "@code-yeongyu/senpi-neo-tui-linux-x64", staged: true },
	{ directory: `${neoPackageDir}/senpi-neo-tui-linux-arm64`, name: "@code-yeongyu/senpi-neo-tui-linux-arm64", staged: true },
	{ directory: `${neoPackageDir}/senpi-neo-tui-windows-x64`, name: "@code-yeongyu/senpi-neo-tui-windows-x64", staged: true },
	{ directory: `${neoPackageDir}/senpi-neo-tui-windows-arm64`, name: "@code-yeongyu/senpi-neo-tui-windows-arm64", staged: true },
	{ directory: `${neoPackageDir}/senpi-neo-tui`, name: "@code-yeongyu/senpi-neo-tui", staged: true },
];

function stagedNeoPackages() {
	const staged = neoPackages.filter((pkg) => existsSync(join(pkg.directory, "package.json")));
	if (staged.length !== 0 && staged.length !== neoPackages.length) {
		throw new Error(
			`${neoPackageDir} is partially staged (${staged.length}/${neoPackages.length}); re-run scripts/generate-neo-npm-packages.mjs.`,
		);
	}
	return staged;
}

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

function assertBuildOutputExists(pkg) {
	if (pkg.staged) {
		assertStagedBinExists(pkg.directory);
		return;
	}
	const packageJson = readPackageJson(pkg.directory);
	if (!sourceOnlyPackages.has(packageJson.name) && !existsSync(join(pkg.directory, "dist"))) {
		throw new Error(`${pkg.directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

// Staged neo packages ship a prebuilt binary/launcher instead of a dist/ build,
// so the "build output exists" gate asserts each declared bin file is present.
function assertStagedBinExists(directory) {
	const packageJson = readPackageJson(directory);
	const bin = packageJson.bin;
	const binPaths = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
	if (binPaths.length === 0) {
		throw new Error(`${directory}/package.json declares no bin; staged neo packages must ship a bin.`);
	}
	for (const relativePath of binPaths) {
		if (!existsSync(join(directory, relativePath))) {
			throw new Error(`${directory}: staged bin ${relativePath} does not exist. Run scripts/generate-neo-npm-packages.mjs.`);
		}
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	const packageJson = readPackageJson(directory);
	if (directory === "packages/coding-agent") {
		assertSenpiPackedWorkspaceFiles(packed);
	}
	if (sourceOnlyPackages.has(packageJson.name)) {
		// `npm pack --dry-run --json` reports paths relative to the package root,
		// while a real tarball prefixes them with `package/`. Tolerate both forms
		// (the same convention as assertSenpiPackedWorkspaceFiles' dryRunPath).
		const filePaths = new Set((packed.files ?? []).map((file) => file.path.replace(/^package\//, "")));
		for (const requiredPath of ["src/index.ts", "README.md", "CHANGELOG.md", "LICENSE"]) {
			if (!filePaths.has(requiredPath)) {
				throw new Error(`${packageJson.name} package tarball is missing ${requiredPath}`);
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

const neoStaged = stagedNeoPackages();
if (neoStaged.length === 0) {
	console.log(`Note: ${neoPackageDir} is not staged; the 7 neo packages are excluded from this run.\n`);
}
const allPackages = [...packages, ...neoStaged];

const packageVersions = new Map();
for (const pkg of allPackages) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name) {
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

const packageStates = allPackages.map((pkg) => ({
	...pkg,
	published: false,
	version: packageVersions.get(pkg.name),
}));

for (const pkg of packageStates) {
	assertBuildOutputExists(pkg);
	pkg.published = isPublished(pkg.name, pkg.version);

	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} is already published; validating package contents only.`);
	} else {
		console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
	}
	validatePack(pkg.directory);
	console.log();
}

if (dryRun) {
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
		continue;
	}

	run("npm", ["publish", "--access", "public", "--tag", "latest", "--provenance", "--ignore-scripts"], {
		cwd: pkg.directory,
	});
	console.log();
}
