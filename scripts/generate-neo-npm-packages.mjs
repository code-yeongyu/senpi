#!/usr/bin/env node
/**
 * Stage the neo (Go TUI) npm distribution into `dist/neo-npm/`.
 *
 * The neo binary ships as six per-platform packages
 * (`@code-yeongyu/senpi-neo-tui-<platform>-<arch>`) plus a meta package
 * (`@code-yeongyu/senpi-neo-tui`) whose `optionalDependencies` install exactly
 * the one matching the host. `packages/coding-agent/src/cli/neo/platform.ts` is
 * the SINGLE source of truth for the npm name/arch spellings; this script only
 * owns the GOOS/GOARCH → npm translation on the build side (see that module's
 * doc comment). Output lives under `dist/neo-npm/` which is gitignored and sits
 * outside the npm workspaces glob, so staging never mutates the workspace tree.
 *
 * Usage (from repo root):
 *   node scripts/generate-neo-npm-packages.mjs <version> [--binaries-dir <dir>] [--out <dir>]
 *
 *   <version>          Version stamped into every generated package.json and into
 *                      the Go build (`-X main.version=<version>`). Required.
 *   --binaries-dir     Reuse pre-built binaries named `senpi-neo-<goos>-<goarch>`
 *                      (as produced by the build-binaries.yml cross-compile loop)
 *                      instead of building them here. When omitted, the six
 *                      binaries are cross-compiled with `go build` using the same
 *                      flags as CI.
 *   --out              Output directory (default: dist/neo-npm).
 *
 * Each generated package carries only a binary/launcher, its package.json, and a
 * README — ZERO lifecycle scripts. macOS binaries are ad-hoc codesigned when a
 * `codesign` tool is available (parity with scripts/build-binaries.sh).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	NEO_PACKAGE_BASE,
	neoBinaryFilename,
	neoBinaryRequirePath,
	neoPackageName,
	resolveNeoTarget,
} from "../packages/coding-agent/src/cli/neo/platform.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const neoModuleDir = join(repoRoot, "packages", "neo");

/**
 * The six release targets. `goos`/`goarch` drive the Go build; `platform`/`arch`
 * are the npm distribution spellings (from platform.ts) used in the package name;
 * `os`/`cpu` are the Node `process.platform`/`process.arch` values npm uses to
 * gate optional-dependency installation.
 */
const TARGETS = [
	{ goos: "darwin", goarch: "amd64", platform: "darwin", arch: "x64", os: "darwin", cpu: "x64" },
	{ goos: "darwin", goarch: "arm64", platform: "darwin", arch: "arm64", os: "darwin", cpu: "arm64" },
	{ goos: "linux", goarch: "amd64", platform: "linux", arch: "x64", os: "linux", cpu: "x64" },
	{ goos: "linux", goarch: "arm64", platform: "linux", arch: "arm64", os: "linux", cpu: "arm64" },
	{ goos: "windows", goarch: "amd64", platform: "windows", arch: "x64", os: "win32", cpu: "x64" },
	{ goos: "windows", goarch: "arm64", platform: "windows", arch: "arm64", os: "win32", cpu: "arm64" },
];

const META_PACKAGE_NAME = `@code-yeongyu/${NEO_PACKAGE_BASE}`;
const REPOSITORY = { type: "git", url: "git+https://github.com/code-yeongyu/senpi.git", directory: "packages/neo" };
const LICENSE = "MIT";

function usage(message) {
	if (message) console.error(`generate-neo-npm-packages: ${message}`);
	console.error("Usage: node scripts/generate-neo-npm-packages.mjs <version> [--binaries-dir <dir>] [--out <dir>]");
	process.exit(1);
}

function parseArgs(argv) {
	let version;
	let binariesDir;
	let outDir = join(repoRoot, "dist", "neo-npm");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--binaries-dir") {
			binariesDir = argv[++i];
			if (binariesDir === undefined) usage("--binaries-dir requires a path");
		} else if (arg === "--out") {
			const value = argv[++i];
			if (value === undefined) usage("--out requires a path");
			outDir = resolve(value);
		} else if (arg === "--version") {
			version = argv[++i];
			if (version === undefined) usage("--version requires a value");
		} else if (arg.startsWith("--")) {
			usage(`unknown option: ${arg}`);
		} else if (version === undefined) {
			version = arg;
		} else {
			usage(`unexpected argument: ${arg}`);
		}
	}
	if (version === undefined || version.length === 0) usage("a version is required");
	return { version, binariesDir: binariesDir ? resolve(binariesDir) : undefined, outDir };
}

/** True when a `codesign` tool is resolvable (macOS build hosts only). */
function hasCodesign() {
	const probe = spawnSync("codesign", ["--version"], { stdio: "ignore" });
	return !probe.error && probe.status === 0;
}

/** Ad-hoc codesign a darwin binary, mirroring scripts/build-binaries.sh. */
function codesignDarwin(binaryPath) {
	spawnSync("codesign", ["--remove-signature", binaryPath], { stdio: "ignore" });
	const result = spawnSync("codesign", ["--force", "--sign", "-", binaryPath], { stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`codesign failed for ${binaryPath}`);
	}
}

/** Cross-compile a single target with `go build`, returning the output path. */
function buildBinary(target, version, buildDir) {
	const outPath = join(buildDir, `senpi-neo-${target.goos}-${target.goarch}`);
	const ldflags = `-s -w -X main.version=${version}`;
	console.log(`  go build ${target.goos}/${target.goarch}`);
	const result = spawnSync(
		"go",
		["build", "-trimpath", "-ldflags", ldflags, "-o", outPath, "./cmd/senpi-neo"],
		{
			cwd: neoModuleDir,
			stdio: "inherit",
			env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0" },
		},
	);
	if (result.status !== 0) {
		throw new Error(`go build failed for ${target.goos}/${target.goarch}`);
	}
	return outPath;
}

/** Resolve the source binary for a target: reuse --binaries-dir, else build. */
function sourceBinary(target, version, binariesDir, buildDir) {
	if (binariesDir !== undefined) {
		const path = join(binariesDir, `senpi-neo-${target.goos}-${target.goarch}`);
		if (!existsSync(path)) {
			throw new Error(`missing prebuilt binary ${path} (expected senpi-neo-<goos>-<goarch> in --binaries-dir)`);
		}
		return path;
	}
	return buildBinary(target, version, buildDir);
}

function neoReadme(name, target) {
	const host = target ? `${target.platform}/${target.arch}` : "the current host";
	return [
		`# ${name}`,
		"",
		`The senpi neo (Go-native) TUI binary for ${host}.`,
		"",
		"This package is an install-time artifact of `@code-yeongyu/senpi-neo-tui` and",
		"`@code-yeongyu/senpi` (`senpi --neo`). It is not meant to be depended on",
		"directly.",
		"",
	].join("\n");
}

function metaReadme() {
	return [
		`# ${META_PACKAGE_NAME}`,
		"",
		"The senpi neo (Go-native) terminal UI. Installing this package pulls in the",
		"matching platform binary via `optionalDependencies` and exposes a `senpi-neo`",
		"launcher that resolves and execs it.",
		"",
		"```sh",
		`npm install -g ${META_PACKAGE_NAME}`,
		"senpi-neo --version",
		"```",
		"",
		"Most users get neo through `senpi --neo`, which resolves the same platform",
		"binary directly.",
		"",
	].join("\n");
}

/**
 * The launcher shim shipped as the meta package's `senpi-neo` bin. It mirrors the
 * launcher resolution in packages/coding-agent/src/cli/neo/resolve-binary.ts: map
 * the host to its platform package's binary require path (baked from platform.ts
 * at generation time) and exec it. Zero runtime dependencies so it works from any
 * install layout.
 */
function metaBinShim() {
	const requirePaths = {};
	for (const [nodePlatform, nodeArch] of [
		["win32", "x64"],
		["win32", "arm64"],
		["darwin", "x64"],
		["darwin", "arm64"],
		["linux", "x64"],
		["linux", "arm64"],
	]) {
		const target = resolveNeoTarget(nodePlatform, nodeArch);
		if (target === undefined) throw new Error(`platform.ts did not resolve ${nodePlatform}/${nodeArch}`);
		requirePaths[`${nodePlatform}/${nodeArch}`] = neoBinaryRequirePath(target);
	}
	return `#!/usr/bin/env node
// GENERATED by scripts/generate-neo-npm-packages.mjs — do not edit.
// Resolves the platform-specific senpi-neo binary from the installed optional
// dependency and execs it, mirroring packages/coding-agent/src/cli/neo/resolve-binary.ts.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const REQUIRE_PATHS = ${JSON.stringify(requirePaths, null, 2)};

const key = \`\${process.platform}/\${process.arch}\`;
const requirePath = REQUIRE_PATHS[key];
if (requirePath === undefined) {
	process.stderr.write(
		\`senpi-neo: no prebuilt binary for this host (\${process.platform}/\${process.arch}). \` +
			"Supported targets: darwin/linux/windows on x64/arm64.\\n",
	);
	process.exit(1);
}

const require = createRequire(import.meta.url);
let binaryPath;
try {
	binaryPath = require.resolve(requirePath);
} catch {
	process.stderr.write(
		\`senpi-neo: the platform package for \${process.platform}/\${process.arch} is not installed. \` +
			"Reinstall @code-yeongyu/senpi-neo-tui to fetch it.\\n",
	);
	process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
	process.stderr.write(\`senpi-neo: failed to launch \${binaryPath}: \${result.error.message}\\n\`);
	process.exit(1);
}
if (typeof result.signal === "string" && result.signal.length > 0) {
	process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
`;
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stagePlatformPackage(target, version, sourcePath, outDir, codesign) {
	const name = neoPackageName(target);
	const binaryName = neoBinaryFilename(target.platform);
	const packageDir = join(outDir, `${NEO_PACKAGE_BASE}-${target.platform}-${target.arch}`);
	const binDir = join(packageDir, "bin");
	mkdirSync(binDir, { recursive: true });

	const binaryDest = join(binDir, binaryName);
	copyFileSync(sourcePath, binaryDest);
	chmodSync(binaryDest, 0o755);
	if (target.goos === "darwin" && codesign) {
		codesignDarwin(binaryDest);
	}

	writeJson(join(packageDir, "package.json"), {
		name,
		version,
		description: `senpi neo (Go-native) TUI binary for ${target.platform} ${target.arch}.`,
		license: LICENSE,
		repository: REPOSITORY,
		os: [target.os],
		cpu: [target.cpu],
		bin: { "senpi-neo": `bin/${binaryName}` },
		files: ["bin", "README.md"],
		preferUnplugged: true,
	});
	writeFileSync(join(packageDir, "README.md"), neoReadme(name, target));
	console.log(`  staged ${name} (bin/${binaryName})`);
	return { name, dir: packageDir };
}

function stageMetaPackage(version, outDir, platformNames) {
	const packageDir = join(outDir, NEO_PACKAGE_BASE);
	const binDir = join(packageDir, "bin");
	mkdirSync(binDir, { recursive: true });

	const shimPath = join(binDir, "senpi-neo.mjs");
	writeFileSync(shimPath, metaBinShim());
	chmodSync(shimPath, 0o755);

	// optionalDependencies pinned exactly (==version) to the platform packages.
	const optionalDependencies = {};
	for (const name of platformNames) {
		optionalDependencies[name] = version;
	}

	writeJson(join(packageDir, "package.json"), {
		name: META_PACKAGE_NAME,
		version,
		description: "senpi neo (Go-native) TUI: installs the matching platform binary and exposes the senpi-neo launcher.",
		license: LICENSE,
		repository: REPOSITORY,
		bin: { "senpi-neo": "bin/senpi-neo.mjs" },
		files: ["bin", "README.md"],
		preferUnplugged: true,
		optionalDependencies,
	});
	writeFileSync(join(packageDir, "README.md"), metaReadme());
	console.log(`  staged ${META_PACKAGE_NAME} (meta)`);
	return { name: META_PACKAGE_NAME, dir: packageDir };
}

function main() {
	const { version, binariesDir, outDir } = parseArgs(process.argv.slice(2));

	console.log(`Staging neo npm packages @ ${version} → ${outDir}`);
	console.log(binariesDir ? `Using prebuilt binaries from ${binariesDir}` : "Cross-compiling binaries with go build");

	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });

	const buildDir = join(outDir, ".build");
	if (binariesDir === undefined) mkdirSync(buildDir, { recursive: true });

	const codesign = hasCodesign();
	if (codesign) console.log("codesign available: darwin binaries will be ad-hoc signed");

	const platformNames = [];
	for (const target of TARGETS) {
		const source = sourceBinary(target, version, binariesDir, buildDir);
		const staged = stagePlatformPackage(target, version, source, outDir, codesign);
		platformNames.push(staged.name);
	}

	stageMetaPackage(version, outDir, platformNames);

	if (binariesDir === undefined) rmSync(buildDir, { recursive: true, force: true });

	console.log(`Done: ${platformNames.length} platform packages + meta staged in ${outDir}`);
}

main();
