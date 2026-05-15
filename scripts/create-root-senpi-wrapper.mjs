import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = dirname(__dirname);

export function shouldWriteGlobalShim(root = defaultRoot, environment = process.env) {
	if (environment.CI) return false;
	if (!existsSync(join(root, ".git"))) return false;
	return environment.SENPI_WRITE_GLOBAL_SHIM === "1";
}

function linkedWrapperScript() {
	return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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
	rmSync(join(distDir, ".senpi-build-head"), { force: true });
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
