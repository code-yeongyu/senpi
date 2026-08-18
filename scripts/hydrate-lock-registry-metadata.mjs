#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageNameFromLockPath, registryMetadataError } from "./install-lock-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const lockfilePath = resolve(repoRoot, "package-lock.json");

export async function hydrateLockRegistryMetadata(lockfile, options = {}) {
	const fetchPackage =
		options.fetchPackage ??
		(async (packageName, version) => {
			const response = await fetch(
				`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
			);
			if (!response.ok) {
				throw new Error(`registry lookup failed for ${packageName}@${version}: HTTP ${response.status}`);
			}
			return response.json();
		});
	const cache = new Map();
	const entries = Object.entries(lockfile.packages ?? {}).filter(
		([lockPath, entry]) => registryMetadataError(lockPath, entry) !== undefined,
	);

	await Promise.all(
		entries.map(async ([lockPath, entry]) => {
			const packageName = packageNameFromLockPath(lockPath);
			if (!packageName || typeof entry.version !== "string") {
				throw new Error(`cannot hydrate registry metadata for ${lockPath}`);
			}
			const registryName = typeof entry.name === "string" ? entry.name : packageName;
			const key = `${registryName}@${entry.version}`;
			let request = cache.get(key);
			if (!request) {
				request = fetchPackage(registryName, entry.version);
				cache.set(key, request);
			}
			const metadata = await request;
			const resolved = metadata?.dist?.tarball;
			const integrity = metadata?.dist?.integrity;
			if (typeof resolved !== "string" || typeof integrity !== "string") {
				throw new Error(`registry metadata is incomplete for ${key}`);
			}
			entry.resolved = resolved;
			entry.integrity = integrity;
		}),
	);
	return lockfile;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
	await hydrateLockRegistryMetadata(lockfile);
	writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
	console.log(`Hydrated registry metadata in ${lockfilePath}`);
}
