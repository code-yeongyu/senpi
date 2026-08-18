#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const lockPath = join(root, "package-lock.json");
const sdkLockPath = "packages/coding-agent/node_modules/@anthropic-ai/claude-agent-sdk";

export async function updateClaudeAgentSdkPlatformLock({ check = false } = {}) {
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	const sdk = lock.packages?.[sdkLockPath];
	if (!sdk) throw new Error(`package-lock.json is missing ${sdkLockPath}`);

	const missing = Object.entries(sdk.optionalDependencies ?? {}).filter(
		([name, version]) => lock.packages[`node_modules/${name}`]?.version !== version,
	);

	if (check) {
		if (missing.length > 0) {
			throw new Error(
				`package-lock.json is missing Claude Agent SDK platform packages: ${missing.map(([name]) => name).join(", ")}`,
			);
		}
		process.stdout.write("Claude Agent SDK platform packages are locked.\n");
		return;
	}

	for (const [name, version] of missing) {
		const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
		if (!response.ok) throw new Error(`Failed to fetch ${name}@${version}: HTTP ${response.status}`);
		const metadata = await response.json();
		lock.packages[`node_modules/${name}`] = {
			version,
			resolved: metadata.dist.tarball,
			integrity: metadata.dist.integrity,
			cpu: metadata.cpu,
			license: metadata.license,
			optional: true,
			os: metadata.os,
			...(metadata.libc === undefined ? {} : { libc: metadata.libc }),
		};
	}

	writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
	process.stdout.write(`Locked ${missing.length} Claude Agent SDK platform package(s).\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	updateClaudeAgentSdkPlatformLock({ check: process.argv.includes("--check") }).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
