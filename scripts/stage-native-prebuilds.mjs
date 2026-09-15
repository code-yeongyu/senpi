#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = join(scriptDir, "..");
const STEMS = ["senpi_pty", "senpi_grep"];

export class StageError extends Error {
	constructor(message, exitCode) {
		super(message);
		this.name = "StageError";
		this.exitCode = exitCode;
	}
}

export function loadNativePrebuildTargets(targetsPath = join(scriptDir, "native-prebuild-targets.json")) {
	return JSON.parse(readFileSync(targetsPath, "utf8"));
}

export function parseManifest(text) {
	const fields = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		fields[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return fields;
}

export function normalizeSha256(value) {
	return String(value ?? "")
		.trim()
		.replace(/^\\+/, "")
		.toLowerCase();
}

function sha256File(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function destPath(rootDir, stem, host) {
	if (stem === "senpi_pty") {
		return join(rootDir, "packages", "pty", "native", "prebuilds", host, `senpi_pty.${host}.node`);
	}
	if (stem === "senpi_grep") {
		return join(rootDir, "packages", "coding-agent", "native", "prebuilds", host, `senpi_grep.${host}.node`);
	}
	throw new StageError(`unknown prebuild stem: ${stem}`, 1);
}

export function parseArgs(argv) {
	const options = {
		allowMissingOptional: false,
		rootDir: defaultRootDir,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--allow-missing-optional") {
			options.allowMissingOptional = true;
		} else if (arg === "--artifacts") {
			options.artifactsDir = argv[++i];
		} else if (arg.startsWith("--artifacts=")) {
			options.artifactsDir = arg.slice("--artifacts=".length);
		} else if (arg === "--expected-sha") {
			options.expectedSha = argv[++i];
		} else if (arg.startsWith("--expected-sha=")) {
			options.expectedSha = arg.slice("--expected-sha=".length);
		} else if (arg === "--root") {
			options.rootDir = argv[++i];
		} else if (arg.startsWith("--root=")) {
			options.rootDir = arg.slice("--root=".length);
		} else {
			throw new StageError(`unknown argument: ${arg}`, 1);
		}
	}
	if (!options.artifactsDir) {
		throw new StageError("missing --artifacts <dir>", 1);
	}
	if (!options.expectedSha) {
		throw new StageError("missing --expected-sha <sha>", 1);
	}
	options.artifactsDir = resolve(options.artifactsDir);
	options.rootDir = resolve(options.rootDir);
	return options;
}

export function stageNativePrebuilds(options) {
	const targets = options.targets ?? loadNativePrebuildTargets();
	const artifactsDir = options.artifactsDir;
	const expectedSha = options.expectedSha;
	const rootDir = options.rootDir ?? defaultRootDir;
	const missingRequired = [];
	const present = [];

	for (const [host, policy] of Object.entries(targets)) {
		const hostDir = join(artifactsDir, `native-prebuild-${host}`);
		if (!existsSync(hostDir)) {
			if (policy?.required) {
				missingRequired.push(host);
			} else {
				console.warn(`warning: missing optional native prebuild host: ${host}`);
			}
			continue;
		}
		present.push({ host, hostDir });
	}

	if (missingRequired.length > 0) {
		throw new StageError(`missing required native prebuild host: ${missingRequired.join(", ")}`, 3);
	}

	const staged = [];
	for (const { host, hostDir } of present) {
		const manifestPath = join(hostDir, "manifest.txt");
		if (!existsSync(manifestPath)) {
			throw new StageError(`missing manifest.txt for ${host}`, 1);
		}
		const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
		if (manifest.source_sha !== expectedSha) {
			throw new StageError(
				`prebuild source mismatch: host ${host} source_sha=${manifest.source_sha ?? ""} expected=${expectedSha}`,
				2,
			);
		}

		const manifestHost = `${manifest.node_platform}-${manifest.node_arch}`;
		if (manifestHost !== host) {
			throw new StageError(`prebuild host mismatch: dir ${host} manifest ${manifestHost}`, 1);
		}

		for (const stem of STEMS) {
			const named = manifest[`file_${stem}`];
			if (!named) {
				throw new StageError(`missing file_${stem} in ${host} manifest`, 1);
			}
			const sourceName = basename(named);
			const sourcePath = join(hostDir, sourceName);
			if (!existsSync(sourcePath)) {
				throw new StageError(`missing ${sourceName} for ${host}`, 1);
			}
			const expectedHash = normalizeSha256(manifest[`sha256_${stem}`]);
			const actualHash = sha256File(sourcePath);
			if (!expectedHash || expectedHash !== actualHash) {
				throw new StageError(
					`sha256 mismatch for ${stem} in ${host}: expected ${expectedHash || "(missing)"} got ${actualHash}`,
					1,
				);
			}
			const destination = destPath(rootDir, stem, host);
			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(sourcePath, destination);
			staged.push(destination);
		}
	}

	return staged;
}

function isMain() {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(import.meta.url) === resolve(entry);
	} catch {
		return false;
	}
}

if (isMain()) {
	try {
		const staged = stageNativePrebuilds(parseArgs(process.argv.slice(2)));
		for (const path of staged) {
			console.log(path);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(error instanceof StageError ? error.exitCode : 1);
	}
}
