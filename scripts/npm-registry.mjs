#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registryPackageNames } from "./registry-packages.mjs";

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

// npm trusted publishing cannot do a package's first publish (senpi#6636): a release that reaches `npm publish` with a
// name the registry does not know ships part of the set and stops. A registry failure propagates from the lookup; it is
// never read as known or unknown.
export function assertRegistryPackagesKnown(
	names = [...registryPackageNames.values()],
	lookup = (name) => queryNpmRegistry(name, "name"),
) {
	const unknown = names.filter((name) => lookup(name) === null);
	if (unknown.length === 0) return;
	throw new Error(
		[
			`the npm registry does not know these publish-set packages (scripts/registry-packages.mjs): ${unknown.join(", ")}`,
			"npm trusted publishing cannot do a first publish. For each name, before releasing (scripts/AGENTS.md, Manual first publish):",
			"  1. With an npm login that maintains the scope, publish a placeholder once: a directory holding only a package.json (name, version 0.0.0, repository), then npm publish --access public.",
			"  2. Attach the trusted publisher: npm trust github <name> --repo code-yeongyu/senpi --file publish-npm.yml --allow-publish",
		].join("\n"),
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		assertRegistryPackagesKnown();
		console.log(`every publish-set package (${registryPackageNames.size}) is known to the npm registry`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
