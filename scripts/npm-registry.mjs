#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// A missing package/version is a normal first publish, not a registry outage.
export function queryNpmRegistry(spec, field) {
	const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["view", spec, field, "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30000,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status === 0 && result.stdout.trim()) {
		return result.stdout;
	}
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return null;
	}
	throw new Error(output ? `Failed to query ${spec}\n${output}` : `Failed to query ${spec}`);
}
