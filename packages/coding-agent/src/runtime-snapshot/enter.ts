import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { materializeRuntimeSnapshot, type RuntimeManifest } from "./layout.ts";
import { readRuntimeSnapshotMarker } from "./marker.ts";
import { claimRuntimeSnapshot, pruneRuntimeSnapshots, withBuildLock, withRuntimeLock } from "./registry.ts";

export const RUNTIME_MANIFEST = "runtime-manifest.json";

export type RuntimeSnapshotDecision =
	| { readonly kind: "run-here" }
	| { readonly kind: "hand-off"; readonly entryUrl: string; readonly snapshotDir: string };

function readRuntimeManifest(bundleDir: string): RuntimeManifest | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(bundleDir, RUNTIME_MANIFEST), "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"buildId" in parsed &&
		typeof parsed.buildId === "string" &&
		/^[A-Za-z0-9._-]+$/.test(parsed.buildId) &&
		"externals" in parsed &&
		Array.isArray(parsed.externals) &&
		parsed.externals.every((name: unknown) => typeof name === "string")
	) {
		return { buildId: parsed.buildId, externals: parsed.externals };
	}
	return undefined;
}

/**
 * Decides where a bundled CLI launch runs. A package manager deletes and rewrites the installed
 * package on every upgrade, so a process that keeps importing chunks from it dies at its next
 * lazy import (#2358). The launch instead runs from `<agentDir>/runtime/<build>-<install>`, a
 * snapshot taken once per build and install, and claims it so it outlives later upgrades.
 * A launch already running from a snapshot only claims it. Any failure keeps the old behavior.
 */
export async function prepareRuntimeSnapshot(
	entryPath: string,
	packageDir: string,
	agentDir: string,
): Promise<RuntimeSnapshotDecision> {
	const bundleDir = dirname(entryPath);
	const runtimeRoot = join(agentDir, "runtime");
	try {
		if (readRuntimeSnapshotMarker(packageDir)) {
			withRuntimeLock(runtimeRoot, () => claimRuntimeSnapshot(packageDir, process.pid));
			return { kind: "run-here" };
		}
		const manifest = readRuntimeManifest(bundleDir);
		if (!manifest || relative(packageDir, bundleDir) !== join("dist", "bundle")) return { kind: "run-here" };
		const installId = createHash("sha256").update(realpathSync(packageDir)).digest("hex").slice(0, 12);
		const snapshotId = `${manifest.buildId}-${installId}`;
		const snapshotDir = join(runtimeRoot, snapshotId);
		const isBuilt = () => readRuntimeSnapshotMarker(snapshotDir)?.buildId === manifest.buildId;
		const claim = () =>
			withRuntimeLock(runtimeRoot, () => {
				if (!isBuilt()) return false;
				claimRuntimeSnapshot(snapshotDir, process.pid);
				pruneRuntimeSnapshots(runtimeRoot, snapshotId, Date.now());
				return true;
			});
		let claimed = claim();
		if (claimed === false) {
			const built = await withBuildLock(runtimeRoot, snapshotId, async () => {
				if (!isBuilt()) await materializeRuntimeSnapshot(packageDir, snapshotDir, manifest);
				return true;
			});
			if (built) claimed = claim();
		}
		if (claimed !== true) return { kind: "run-here" };
		const entryUrl = pathToFileURL(join(snapshotDir, "dist", "bundle", basename(entryPath))).href;
		return { kind: "hand-off", entryUrl, snapshotDir };
	} catch {
		// no-excuse-ok: catch - the snapshot only adds upgrade resilience; startup must never fail
		// because of it (read-only agent dir, exotic layout). Running in place is the old behavior,
		// and a later missing chunk is still reported by the install-changed notice.
		return { kind: "run-here" };
	}
}
