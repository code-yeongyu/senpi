import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "../../../../config.ts";
import type { Rule, Ruleset } from "./types.ts";

const PERMISSIONS_FILE = "permissions-approved.jsonl";
const MIGRATED_MARKER = ".migrated";

/**
 * Stamp the answer path (persistAlways / migration) puts on every store line. It is bookkeeping, not
 * a security boundary: whoever can write the store can write the marker too. The protection is the
 * store's location outside the workspace and the dispatch guard that refuses the agent's tools on it.
 */
const USER_ANSWER_SOURCE = "user-answer";

function getLegacyPermissionsPath(projectDir: string): string {
	return path.join(projectDir, CONFIG_DIR_NAME, PERMISSIONS_FILE);
}

/** Realpath of the project (symlinks resolved); falls back to the normalized spelling when absent. */
function canonicalProjectDir(projectDir: string): string {
	try {
		return fs.realpathSync.native(projectDir);
	} catch {
		return path.resolve(projectDir);
	}
}

/** The per-user store for one project: out of the workspace, keyed by the project's real path. */
export function approvedStorePath(agentDir: string, projectDir: string): string {
	const hash = createHash("sha256").update(canonicalProjectDir(projectDir)).digest("hex").slice(0, 16);
	return path.join(agentDir, "permissions", "approved", `${hash}.jsonl`);
}

/** The store path the permission system must never let the agent write (defence in depth). */
export function approvedStoreRealPath(agentDir: string, projectDir: string): string {
	const store = approvedStorePath(agentDir, projectDir);
	try {
		return fs.realpathSync.native(store);
	} catch {
		return store;
	}
}

/** A well-formed pattern is a non-empty string without embedded newlines. */
function isWellFormedPattern(pattern: unknown): pattern is string {
	return typeof pattern === "string" && pattern.length > 0 && !pattern.includes("\n") && !pattern.includes("\r");
}

/**
 * A concrete permission kind names a real gated tool (bash, edit, read, or any custom/MCP tool);
 * only a wildcard or empty permission is a forgery vector and is rejected. The review's forge is
 * specifically `{"permission":"*","pattern":"*","action":"allow"}` — a wildcard permission.
 */
function isConcretePermission(permission: unknown): permission is string {
	return typeof permission === "string" && permission.length > 0 && permission !== "*" && !permission.includes("\n");
}
/**
 * Validates one loaded line: action 'allow', a concrete (non-wildcard) permission kind and a
 * well-formed pattern. Store lines must also carry the source marker; the one-time legacy import does
 * not require it, because senpi never wrote one before the store moved (requiring it dropped every
 * saved "Always" answer). Anything else is dropped.
 */
function toApprovedRule(value: unknown, requireSource: boolean): Rule | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.action !== "allow") return undefined;
	if (!isConcretePermission(candidate.permission)) return undefined;
	if (!isWellFormedPattern(candidate.pattern)) return undefined;
	if (requireSource && candidate.source !== USER_ANSWER_SOURCE) return undefined;
	return { permission: candidate.permission, pattern: candidate.pattern, action: "allow" };
}

function readRules(filePath: string, requireSource = true): Ruleset {
	if (!fs.existsSync(filePath)) return [];
	// Never read through a symlink at the store path: a linked-in line is not honored.
	try {
		if (fs.lstatSync(filePath).isSymbolicLink()) return [];
	} catch {
		return [];
	}
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter((line) => line.trim() !== "");
	const rules: Rule[] = [];
	for (const line of lines) {
		try {
			const rule = toApprovedRule(JSON.parse(line), requireSource);
			if (rule) rules.push(rule);
		} catch {}
	}
	return rules;
}

/**
 * Loads the project's approved rules from the agent-dir store. On first load for a project, a
 * legacy `<cwd>/.senpi/permissions-approved.jsonl` is imported ONCE (allow-only, concrete
 * permission, well-formed pattern; no source marker, which pre-store lines never had). The file is
 * removed only when every line was imported; either way the marker means a line planted there later
 * is never honored. A failed import removes any partial store
 * and leaves the legacy file, so the next load retries. Later loads read only the store.
 */
export function loadApproved(agentDir: string, projectDir: string): Ruleset {
	const storePath = approvedStorePath(agentDir, projectDir);
	const legacyPath = getLegacyPermissionsPath(projectDir);
	const migratedMarker = `${storePath}${MIGRATED_MARKER}`;
	const alreadyMigrated = fs.existsSync(migratedMarker) || fs.existsSync(storePath);

	if (!alreadyMigrated && fs.existsSync(legacyPath)) {
		const imported = readRules(legacyPath, false);
		const legacyLines = fs
			.readFileSync(legacyPath, "utf-8")
			.split("\n")
			.filter((line) => line.trim() !== "").length;
		try {
			const dir = path.dirname(storePath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const lines = imported.map((rule) => JSON.stringify({ ...rule, source: USER_ANSWER_SOURCE })).join("\n");
			fs.writeFileSync(storePath, lines ? `${lines}\n` : "", { flag: "w" });
			fs.writeFileSync(migratedMarker, "");
			// Remove the legacy file only when every line made it into the store: a line the import
			// refused stays on disk for the user to see, and the marker keeps it from ever being read.
			if (imported.length === legacyLines) fs.rmSync(legacyPath, { force: true });
		} catch (error) {
			// Undo a partial import, so "already migrated" stays false and the next load retries it.
			fs.rmSync(storePath, { force: true });
			fs.rmSync(migratedMarker, { force: true });
			console.error(
				`permission: importing the legacy approvals file failed; retrying on the next load (${String(error)})`,
			);
		}
		return imported;
	}

	return readRules(storePath);
}

/** Cheap identity of the store: mtime + size, so a service re-reads only on change. */
export function approvedFileVersion(agentDir: string, projectDir: string): string | undefined {
	const filePath = approvedStorePath(agentDir, projectDir);
	try {
		const stat = fs.statSync(filePath);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

/** Appends user-answer rules to the store, each stamped with the source marker. */
export function appendApproved(agentDir: string, projectDir: string, rules: Rule[]): void {
	if (rules.length === 0) return;
	const filePath = approvedStorePath(agentDir, projectDir);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	// Never write through a symlink at the store path: an attacker-chosen target must stay untouched.
	if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) return;
	const lines = `${rules.map((rule) => JSON.stringify({ ...rule, source: USER_ANSWER_SOURCE })).join("\n")}\n`;
	fs.appendFileSync(filePath, lines, { flag: "a" });
}

export function clearApproved(agentDir: string, projectDir: string): void {
	const filePath = approvedStorePath(agentDir, projectDir);
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function compactApproved(agentDir: string, projectDir: string): void {
	const filePath = approvedStorePath(agentDir, projectDir);
	if (!fs.existsSync(filePath)) return;
	const rules = loadApproved(agentDir, projectDir);
	const seen = new Map<string, Rule>();
	for (const rule of rules) seen.set(`${rule.permission}:${rule.pattern}`, rule);
	const uniqueRules = Array.from(seen.values());
	const lines = uniqueRules.map((rule) => JSON.stringify({ ...rule, source: USER_ANSWER_SOURCE })).join("\n");
	fs.writeFileSync(filePath, lines ? `${lines}\n` : "", { flag: "w" });
}
