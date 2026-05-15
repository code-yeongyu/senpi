import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = dirname(__dirname);

export function shouldWriteGlobalShim(root = defaultRoot, environment = process.env) {
	if (environment.CI) {
		return false;
	}
	return existsSync(join(root, ".git"));
}

function linkedWrapperScript() {
	return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildStampPath = join(root, "dist/.senpi-build-head");
const inputs = [
	"package.json",
	"scripts/build-all.mjs",
	"scripts/create-root-senpi-wrapper.mjs",
	"packages/agent/package.json",
	"packages/agent/src",
	"packages/ai/package.json",
	"packages/ai/src",
	"packages/coding-agent/package.json",
	"packages/coding-agent/src",
	"packages/tui/package.json",
	"packages/tui/src",
];
const outputs = [
	"packages/agent/dist/index.js",
	"packages/ai/dist/index.js",
	"packages/coding-agent/dist/senpi",
	"packages/tui/dist/index.js",
];

function newestMtimeMs(path) {
	if (!existsSync(path)) return 0;
	const stat = statSync(path);
	if (stat.isFile()) return stat.mtimeMs;
	if (!stat.isDirectory()) return 0;
	let newest = stat.mtimeMs;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".git") continue;
		const child = join(path, entry.name);
		newest = Math.max(newest, newestMtimeMs(child));
	}
	return newest;
}

function allExist(paths) {
	for (const relativePath of paths) {
		if (!existsSync(join(root, relativePath))) return false;
	}
	return true;
}

function currentGitHead() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

function buildStampIsStale() {
	const head = currentGitHead();
	if (!head) return false;
	if (!existsSync(buildStampPath)) return true;
	return readFileSync(buildStampPath, "utf8").trim() !== head;
}

function linkedBuildIsStale() {
	if (!existsSync(join(root, ".git"))) return false;
	if (buildStampIsStale()) return true;
	if (!allExist(outputs)) return true;
	const newestInput = Math.max(...inputs.map((relativePath) => newestMtimeMs(join(root, relativePath))));
	return newestInput > statSync(buildStampPath).mtimeMs;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.signal) {
		process.kill(process.pid, result.signal);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

if (linkedBuildIsStale()) {
	run(process.execPath, [join(root, "scripts/build-all.mjs")], { cwd: root, env: process.env });
}

const cliPath = join(root, "packages/coding-agent/dist/senpi");
if (!existsSync(cliPath)) {
	console.error("senpi build output is missing. Run npm run build from the repo root.");
	process.exit(1);
}

run(process.execPath, [cliPath, ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env });
`;
}

export function createRootSenpiWrapper({
	root = defaultRoot,
	globalPrefix,
	writeGlobalShim = shouldWriteGlobalShim(root),
} = {}) {
	const distDir = join(root, "dist");
	const wrapperPath = join(distDir, "senpi");

	mkdirSync(distDir, { recursive: true });
	writeFileSync(wrapperPath, linkedWrapperScript(), "utf8");
	chmodSync(wrapperPath, 0o755);

	if (!writeGlobalShim) {
		return { wrapperPath, globalShimPath: undefined, globalShimWritten: false };
	}

	const resolvedGlobalPrefix = globalPrefix ?? execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
	const globalBinDir = join(resolvedGlobalPrefix, "bin");
	const globalShimPath = join(globalBinDir, "senpi");

	mkdirSync(globalBinDir, { recursive: true });
	if (existsSync(globalShimPath)) {
		rmSync(globalShimPath);
	}
	writeFileSync(
		globalShimPath,
		`#!/bin/sh
exec "${wrapperPath}" "$@"
`,
		"utf8",
	);
	chmodSync(globalShimPath, 0o755);

	return { wrapperPath, globalShimPath, globalShimWritten: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	createRootSenpiWrapper();
}
