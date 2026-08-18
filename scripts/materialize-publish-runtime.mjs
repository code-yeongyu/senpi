import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const runtimeRoot = join("packages", "coding-agent", "node_modules");

function verifyIntegrity(buffer, integrity) {
	const [algorithm, expected] = integrity.split("-", 2);
	if (!algorithm || !expected) {
		throw new Error(`Unsupported integrity value: ${integrity}`);
	}
	const actual = createHash(algorithm).update(buffer).digest("base64");
	if (actual !== expected) {
		throw new Error(`Integrity mismatch: expected ${integrity}, received ${algorithm}-${actual}`);
	}
}

export function collectMissingLockedRuntimePackages(lock, root = runtimeRoot) {
	const missing = [];
	for (const [lockPath, entry] of Object.entries(lock.packages)) {
		if (!lockPath.startsWith("node_modules/") || !entry.optional || !entry.resolved || !entry.integrity) {
			continue;
		}
		const packageName = lockPath.slice("node_modules/".length);
		const target = join(root, packageName);
		if (!existsSync(target)) {
			missing.push({ packageName, target, resolved: entry.resolved, integrity: entry.integrity });
		}
	}
	return missing;
}

export async function materializeMissingPublishRuntime({
	lockPath = join("packages", "coding-agent", "publish-deps.lock.json"),
	root = runtimeRoot,
	fetchImpl = fetch,
	runCommand = spawnSync,
	log = console.log,
} = {}) {
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	const missing = collectMissingLockedRuntimePackages(lock, root);
	for (const pkg of missing) {
		log(`Materializing locked runtime package ${pkg.packageName}`);
		const response = await fetchImpl(pkg.resolved);
		if (!response.ok) {
			throw new Error(`Failed to download ${pkg.packageName}: HTTP ${response.status}`);
		}
		const archive = Buffer.from(await response.arrayBuffer());
		verifyIntegrity(archive, pkg.integrity);

		const temporaryRoot = mkdtempSync(join(tmpdir(), "senpi-runtime-"));
		const archivePath = join(temporaryRoot, "package.tgz");
		const extractedPath = join(temporaryRoot, "package");
		writeFileSync(archivePath, archive);
		const result = runCommand("tar", ["-xzf", archivePath, "-C", temporaryRoot], { encoding: "utf8" });
		if (result.status !== 0) {
			throw new Error(`Failed to extract ${pkg.packageName}: ${result.stderr || result.stdout || result.status}`);
		}
		mkdirSync(dirname(pkg.target), { recursive: true });
		cpSync(extractedPath, pkg.target, { recursive: true });
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
	return missing.map(({ packageName }) => packageName);
}
