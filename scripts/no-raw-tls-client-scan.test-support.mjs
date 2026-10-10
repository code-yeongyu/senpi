import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRawTlsClients } from "./no-raw-tls-client.test-support.mjs";

export { findRawTlsClients, normalizeCallText } from "./no-raw-tls-client.test-support.mjs";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export function evaluateShippedSource(scan, allowlist) {
	const offenders = [];
	const matched = new Map(allowlist.map((entry) => [entry, 0]));
	const scannedPaths = new Set(scan.map((item) => item.path));
	for (const item of scan) {
		for (const hit of findRawTlsClients(item.content)) {
			const entry = allowlist.find((candidate) => candidate.file === item.path && candidate.call === hit.text);
			if (entry) {
				matched.set(entry, matched.get(entry) + 1);
				continue;
			}
			offenders.push(item.path + ":" + hit.line + "  " + hit.text);
		}
	}
	const stale = [];
	for (const entry of allowlist) {
		const seen = matched.get(entry) ?? 0;
		if (!scannedPaths.has(entry.file)) {
			stale.push(entry.file + ": stale allowlist entry (no longer scanned)");
		} else if (seen !== entry.count) {
			stale.push(entry.file + ": expected " + entry.call + " x" + entry.count + ", found x" + seen);
		}
		if (!entry.reason || !entry.reason.trim()) {
			stale.push(entry.file + ": allowlist entry without a reason");
		}
	}
	return { offenders, stale };
}

export function listTrackedFiles() {
	return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\0")
		.filter(Boolean);
}

// Only ENOENT is tolerated (review D4): a vanished tracked file is a race,
// anything else (permissions, EISDIR) must fail loudly, not shrink scope.
export function readSourceFile(absolutePath) {
	try {
		return readFileSync(absolutePath, "utf8");
	} catch (error) {
		if (error && error.code === "ENOENT") return null;
		throw error;
	}
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXCLUDED_SEGMENTS = new Set([
	"test",
	"tests",
	"__tests__",
	"fixtures",
	"__fixtures__",
	"test-support",
	"test-fixtures",
	"references",
	"docs",
	"node_modules",
]);

export function isScannedSourceFile(relativePath) {
	const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	if (/\.(test|spec)\.[a-z]+$/.test(name)) return false;
	if (name.endsWith(".d.ts")) return false;
	if (!SOURCE_EXTENSIONS.has(path.extname(name))) return false;
	const segments = relativePath.split("/");
	if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
	return true;
}

// Truly third-party npm-dependency bundles would be named here, one
// comment per bundle. None are tracked today: git ls-files already keeps
// untracked node_modules out of the scan (review O1).
export const THIRD_PARTY_EXCLUDED_BUNDLES = [];

// Tracked files only (review O1): install and build output (node_modules,
// dist, gitignored bundles) never enter the scan, so the verdict cannot
// depend on whether a build ran. senpi ships dist built from
// packages/*/src (plus senpi-codemode src), which is the scan root.
export function collectShippedSourceFiles() {
	return listTrackedFiles()
		.filter(
			(file) =>
				!THIRD_PARTY_EXCLUDED_BUNDLES.includes(file) &&
				/^packages\/[^/]+\/src\//.test(file) &&
				isScannedSourceFile(file),
		)
		.sort();
}
