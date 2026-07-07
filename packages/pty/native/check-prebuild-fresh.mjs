#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = join(scriptDir, "..", "..", "..");
const NAPI_CLI_VERSION = "3.7.2";

const napiTargetByHost = new Map([
	["darwin-arm64", "aarch64-apple-darwin"],
	["darwin-x64", "x86_64-apple-darwin"],
	["linux-arm64", "aarch64-unknown-linux-gnu.2.17"],
	["linux-x64", "x86_64-unknown-linux-gnu.2.17"],
	["win32-arm64", "aarch64-pc-windows-msvc"],
	["win32-x64", "x86_64-pc-windows-msvc"],
]);

export function getHost(platform = process.platform, arch = process.arch) {
	return `${platform}-${arch}`;
}

export function getVendoredPrebuildPath(rootDir, host) {
	return join(rootDir, "packages", "pty", "native", "prebuilds", host, `senpi_pty.${host}.node`);
}

export async function checkPrebuildFreshness(options = {}) {
	const rootDir = options.rootDir ?? defaultRootDir;
	const host = options.host ?? getHost();
	const napiTarget = options.napiTarget ?? napiTargetByHost.get(host);
	if (!napiTarget) {
		throw new Error(`error: unsupported native prebuild host target ${host}`);
	}

	const tempDir = options.tempDir ?? (await mkdtemp(join(tmpdir(), `senpi-pty-prebuild-${host}-`)));
	const ownsTempDir = options.tempDir === undefined;
	try {
		const builtFile =
			options.builtFile ??
			(await buildHostPrebuild({
				host,
				napiTarget,
				outputDir: join(tempDir, "output"),
				rootDir,
				targetDir: join(rootDir, "target", "senpi-pty-prebuild", host),
			}));
		const vendoredFile = getVendoredPrebuildPath(rootDir, host);

		if (options.update) {
			await mkdir(dirname(vendoredFile), { recursive: true });
			await copyFile(builtFile, vendoredFile);
			return { builtFile, host, napiTarget, status: "updated", vendoredFile };
		}

		await assertFileExists(vendoredFile, `error: missing vendored prebuild for ${host}: ${vendoredFile}`);
		const [builtBytes, vendoredBytes] = await Promise.all([readFile(builtFile), readFile(vendoredFile)]);
		if (!builtBytes.equals(vendoredBytes)) {
			throw new Error(
				`error: stale vendored prebuild for ${host}: ${vendoredFile} differs from rebuilt ${builtFile} (${napiTarget})`,
			);
		}

		return { builtFile, host, napiTarget, status: "fresh", vendoredFile };
	} finally {
		if (ownsTempDir) await rm(tempDir, { force: true, recursive: true });
	}
}

async function buildHostPrebuild({ rootDir, host, napiTarget, outputDir, targetDir }) {
	await mkdir(outputDir, { recursive: true });
	await run(
		"npm",
		[
			"exec",
			"--yes",
			"--package",
			`@napi-rs/cli@${NAPI_CLI_VERSION}`,
			"--",
			"napi",
			"build",
			"--manifest-path",
			"crates/senpi-pty/Cargo.toml",
			"--package-json-path",
			"crates/senpi-pty/package.json",
			"--target",
			napiTarget,
			"--target-dir",
			targetDir,
			"--output-dir",
			outputDir,
			"--release",
			"--platform",
			"--",
			"--locked",
		],
		rootDir,
	);

	const builtFile = join(outputDir, `senpi_pty.${host}.node`);
	await assertFileExists(builtFile, `error: napi build did not produce expected host target ${host}: ${builtFile}`);
	return builtFile;
}

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, RUSTFLAGS: appendRustflags(process.env.RUSTFLAGS, `--remap-path-prefix=${cwd}=.`) },
			shell: false,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`error: ${command} ${args.join(" ")} failed with exit ${code ?? 1}`));
			}
		});
	});
}

function appendRustflags(current, flag) {
	return current ? `${current} ${flag}` : flag;
}

async function assertFileExists(file, message) {
	try {
		await access(file, fsConstants.R_OK);
	} catch {
		throw new Error(message);
	}
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--update") {
			options.update = true;
		} else if (arg === "--host") {
			options.host = argv[++i];
		} else if (arg.startsWith("--host=")) {
			options.host = arg.slice("--host=".length);
		} else if (arg === "--root") {
			options.rootDir = argv[++i];
		} else if (arg.startsWith("--root=")) {
			options.rootDir = arg.slice("--root=".length);
		} else if (arg === "--built-file") {
			options.builtFile = argv[++i];
		} else if (arg.startsWith("--built-file=")) {
			options.builtFile = arg.slice("--built-file=".length);
		} else {
			throw new Error(`error: unknown argument ${arg}`);
		}
	}
	return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const result = await checkPrebuildFreshness(parseArgs(process.argv.slice(2)));
		console.log(`${result.status} native prebuild for ${result.host}: ${result.vendoredFile}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
