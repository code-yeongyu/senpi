import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CONFIG_DIR_NAME, DISPLAY_VERSION } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";

const CACHE_FILE_VERSION = 1;
const MAX_CACHED_SCOPES = 8;

export interface HelpFlagsScope {
	readonly cwd: string;
	readonly agentDir: string;
	readonly cliExtensionPaths: readonly string[];
	readonly noExtensions: boolean;
	readonly projectTrusted: boolean;
}

interface InputStamp {
	readonly path: string;
	readonly state: string;
}

interface CachedScope {
	readonly writtenAt: number;
	readonly appVersion: string;
	readonly inputs: readonly InputStamp[];
	readonly flags: readonly ExtensionFlag[];
}

interface CacheFile {
	readonly version: number;
	readonly scopes: Record<string, CachedScope>;
}

function cachePath(agentDir: string): string {
	return join(agentDir, "cache", "help-flags.json");
}

function scopeKey(scope: HelpFlagsScope): string {
	const material = [
		scope.cwd,
		scope.noExtensions ? "no-extensions" : "extensions",
		scope.projectTrusted ? "trusted" : "untrusted",
		...scope.cliExtensionPaths,
	].join("\u0000");
	return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * A path's identity for cache validation. Directories carry only their mtime, which is what
 * changes when an extension file is added or removed inside them; files carry mtime and size,
 * so an in-place upgrade of a bundled plugin invalidates the entry it produced.
 */
function stamp(path: string): string {
	try {
		const stats = statSync(path);
		if (stats.isDirectory()) return `d:${stats.mtimeMs}`;
		return `f:${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "absent";
	}
}

function discoveryInputs(scope: HelpFlagsScope, extensionPaths: readonly string[]): string[] {
	const paths = new Set<string>([
		join(scope.agentDir, "settings.json"),
		join(scope.agentDir, "extensions"),
		join(scope.agentDir, "trust.json"),
		join(scope.cwd, CONFIG_DIR_NAME, "settings.json"),
		join(scope.cwd, CONFIG_DIR_NAME, "extensions"),
	]);
	for (const path of extensionPaths) {
		if (!isAbsolute(path)) continue;
		paths.add(path);
		paths.add(dirname(path));
	}
	for (const path of scope.cliExtensionPaths) {
		if (!isAbsolute(path)) continue;
		paths.add(path);
	}
	return [...paths].sort();
}

function readCacheFile(agentDir: string): CacheFile | undefined {
	try {
		const parsed = JSON.parse(readFileSync(cachePath(agentDir), "utf8")) as CacheFile;
		if (parsed.version !== CACHE_FILE_VERSION || typeof parsed.scopes !== "object" || parsed.scopes === null) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * Flags a previous run resolved for this exact scope, or `undefined` when anything that feeds
 * extension discovery changed. Never throws: a help screen must not depend on its own cache.
 */
export function readHelpFlagsCache(scope: HelpFlagsScope): ExtensionFlag[] | undefined {
	const cached = readCacheFile(scope.agentDir)?.scopes[scopeKey(scope)];
	if (!cached || cached.appVersion !== DISPLAY_VERSION || !Array.isArray(cached.inputs)) return undefined;
	for (const input of cached.inputs) {
		if (stamp(input.path) !== input.state) return undefined;
	}
	return [...cached.flags];
}

/**
 * Record the flags a full extension load produced. Failure is silent by contract: this runs on
 * the startup path, where a cache write must never be the reason a launch fails.
 */
export function writeHelpFlagsCache(options: {
	readonly scope: HelpFlagsScope;
	readonly flags: readonly ExtensionFlag[];
	readonly extensionPaths: readonly string[];
}): void {
	const { scope, flags, extensionPaths } = options;
	try {
		const existing = readCacheFile(scope.agentDir);
		const scopes: Record<string, CachedScope> = { ...(existing?.scopes ?? {}) };
		scopes[scopeKey(scope)] = {
			writtenAt: Date.now(),
			appVersion: DISPLAY_VERSION,
			inputs: discoveryInputs(scope, extensionPaths).map((path) => ({ path, state: stamp(path) })),
			flags: [...flags],
		};
		const keptEntries = Object.entries(scopes)
			.sort(([, left], [, right]) => right.writtenAt - left.writtenAt)
			.slice(0, MAX_CACHED_SCOPES);
		const file: CacheFile = { version: CACHE_FILE_VERSION, scopes: Object.fromEntries(keptEntries) };
		const target = cachePath(scope.agentDir);
		mkdirSync(dirname(target), { recursive: true });
		const temporary = `${target}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(file), { mode: 0o600 });
		try {
			renameSync(temporary, target);
		} catch (error) {
			if (existsSync(temporary)) rmSync(temporary, { force: true });
			throw error;
		}
	} catch {
		return;
	}
}
