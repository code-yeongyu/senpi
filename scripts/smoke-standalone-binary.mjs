#!/usr/bin/env node

import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [binaryArgument, workerArgument, runtimeDirectoryArgument] = process.argv.slice(2);
if (!binaryArgument || !workerArgument) {
	throw new Error("Usage: smoke-standalone-binary.mjs <binary> <build-time-worker>");
}

const binaryPath = resolve(binaryArgument);
const workerPath = resolve(workerArgument);
if (!existsSync(binaryPath)) {
	throw new Error(`Standalone binary missing: ${binaryPath}`);
}
if (!existsSync(workerPath)) {
	throw new Error(`Build-time worker missing: ${workerPath}`);
}

const hiddenWorkerPath = `${workerPath}.senpi-smoke-hidden-${process.pid}`;
const smokeDirectory = runtimeDirectoryArgument
	? resolve(runtimeDirectoryArgument)
	: mkdtempSync(join(tmpdir(), "senpi-standalone-smoke-"));

try {
	renameSync(workerPath, hiddenWorkerPath);
	for (const argument of ["--help", "--version"]) {
		const result = spawnSync(binaryPath, [argument], {
			cwd: smokeDirectory,
			encoding: "utf8",
			env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" },
		});
		if (result.error || result.status !== 0 || result.stdout.trim() === "") {
			const detail = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
			throw new Error(`${basename(binaryPath)} ${argument} failed after relocation: ${detail}`);
		}
	}

	const rpcRequestId = "standalone-smoke-surfaces";
	const rpcResult = spawnSync(
		binaryPath,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--offline",
			"--no-context-files",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
		],
		{
			cwd: smokeDirectory,
			encoding: "utf8",
			env: {
				...process.env,
				PAGER: "cat",
				GIT_PAGER: "cat",
				SENPI_CODING_AGENT_DIR: join(smokeDirectory, "agent"),
			},
			input: `${JSON.stringify({ id: rpcRequestId, type: "get_loaded_surfaces" })}\n`,
		},
	);
	if (rpcResult.error || rpcResult.status !== 0) {
		const detail = rpcResult.error?.message ?? (rpcResult.stderr.trim() || `exit ${rpcResult.status}`);
		throw new Error(`${basename(binaryPath)} codemode RPC smoke failed after relocation: ${detail}`);
	}
	const protocolMessages = rpcResult.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`${basename(binaryPath)} codemode RPC smoke received malformed RPC output: ${line}`);
			}
		});
	const responses = protocolMessages
		.filter(
			(response) =>
				response?.id === rpcRequestId &&
				response?.type === "response" &&
				response?.command === "get_loaded_surfaces",
		);
	if (responses.length !== 1) {
		throw new Error(
			`${basename(binaryPath)} codemode RPC smoke expected one loaded-surfaces response, got ${responses.length}`,
		);
	}
	const response = responses[0];
	if (response.success !== true) {
		throw new Error(
			`${basename(binaryPath)} codemode RPC smoke received an unsuccessful loaded-surfaces response: ${JSON.stringify(response)}`,
		);
	}
	const codemodeExtensions = response.data?.extensions?.filter(
		(extension) =>
			extension?.name === "codemode" &&
			extension?.path === "<builtin:codemode>" &&
			extension?.enabled === true,
	);
	if (codemodeExtensions?.length !== 1) {
		throw new Error(
			`${basename(binaryPath)} codemode RPC smoke expected one enabled <builtin:codemode> extension, got ${codemodeExtensions?.length ?? 0}`,
		);
	}
	if (/Bundled extension unavailable|Failed to load extension[^\n]*codemode/i.test(rpcResult.stderr)) {
		throw new Error(`${basename(binaryPath)} codemode RPC smoke emitted a load-failure warning: ${rpcResult.stderr.trim()}`);
	}
} finally {
	if (existsSync(hiddenWorkerPath)) {
		renameSync(hiddenWorkerPath, workerPath);
	}
	if (!runtimeDirectoryArgument) {
		rmSync(smokeDirectory, { recursive: true, force: true });
	}
}

console.log("binary relocation smoke OK");
