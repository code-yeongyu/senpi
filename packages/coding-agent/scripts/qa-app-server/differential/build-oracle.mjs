#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ORACLE_MANIFEST = "/Users/yeongyu/local-workspaces/codex/codex-rs/Cargo.toml";
export const ORACLE_BINARY = "/Users/yeongyu/local-workspaces/codex/codex-rs/target/debug/codex-app-server";
const BUILD_ARGS = ["build", "--manifest-path", ORACLE_MANIFEST, "-p", "codex-app-server", "--bin", "codex-app-server"];

class OracleBuildError extends Error {
	name = "OracleBuildError";
}

export async function buildOracle() {
	process.stdout.write(`ORACLE_COMMAND=cargo ${BUILD_ARGS.join(" ")}\n`);
	const exitCode = await new Promise((resolve, reject) => {
		const buildEnv = { ...process.env };
		delete buildEnv.CARGO_TARGET_DIR;
		delete buildEnv.CARGO_BUILD_TARGET;
		const child = spawn("cargo", BUILD_ARGS, { env: buildEnv, stdio: "inherit" });
		child.once("error", reject);
		child.once("close", (code, signal) => resolve(code ?? signal ?? "unknown"));
	});
	if (exitCode !== 0) throw new OracleBuildError(`Codex oracle cargo build exited with ${String(exitCode)}.`);
	accessSync(ORACLE_BINARY, constants.X_OK);
	if (!statSync(ORACLE_BINARY).isFile()) throw new OracleBuildError(`Codex oracle binary is not a file: ${ORACLE_BINARY}`);
	process.stdout.write(`ORACLE_BINARY=${ORACLE_BINARY}\nORACLE_BUILD=pass\n`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try {
		await buildOracle();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
