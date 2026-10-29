import type { Stats } from "node:fs";
import { readSkillMarkdownSource, SKILL_FRONTMATTER_PREFIX_BYTES } from "./skill-discovery.ts";

/**
 * Coarse filesystem clocks (Linux jiffies, FAT's 2 s) can give a same-size rewrite the same stamp as
 * the read before it. As git does for racy index entries, a read is reused only when the file was last
 * changed well before that read, so no later write can share its stamp. The change time is the later
 * of mtime and ctime: cp -p, tar, rsync -t and utimes restore an old mtime, and only ctime moves.
 */
const RACY_WRITE_WINDOW_MS = 3000;

export interface SkillSourceCacheLimits {
	/** A source larger than this (no closing `---` within the frontmatter prefix) is never kept. */
	readonly maxEntryBytes: number;
	/** Kept sources never exceed this in total; the oldest are dropped first. */
	readonly maxTotalBytes: number;
}

const DEFAULT_LIMITS: SkillSourceCacheLimits = {
	maxEntryBytes: 8 * SKILL_FRONTMATTER_PREFIX_BYTES,
	maxTotalBytes: 8 * 1024 * 1024,
};

interface CachedSkillSource {
	readonly stamp: string;
	readonly source: string;
	readonly bytes: number;
}

function statStamp(stats: Stats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

export type ReadUserSkillSource = (filePath: string, stats: Stats) => string;

/** `readSkillMarkdownSource` for user skill files, reusing the last read while `stats` still matches it. */
export function createSkillSourceCache(
	limits: SkillSourceCacheLimits = DEFAULT_LIMITS,
	now: () => number = () => Date.now(),
): ReadUserSkillSource {
	const sources = new Map<string, CachedSkillSource>();
	let totalBytes = 0;
	const forget = (filePath: string): void => {
		const entry = sources.get(filePath);
		if (entry === undefined) return;
		sources.delete(filePath);
		totalBytes -= entry.bytes;
	};
	return (filePath, stats) => {
		const stamp = statStamp(stats);
		const cached = sources.get(filePath);
		if (cached?.stamp === stamp) return cached.source;
		const source = readSkillMarkdownSource(filePath);
		forget(filePath);
		// The local clock judges the file's change time, as in git; a share whose clock runs behind ours by
		// more than the window can still make a just-written file look settled.
		if (Math.max(stats.mtimeMs, stats.ctimeMs) > now() - RACY_WRITE_WINDOW_MS) return source;
		const bytes = Buffer.byteLength(source);
		if (bytes > limits.maxEntryBytes) return source;
		sources.set(filePath, { stamp, source, bytes });
		totalBytes += bytes;
		for (const oldest of sources.keys()) {
			if (totalBytes <= limits.maxTotalBytes) break;
			forget(oldest);
		}
		return source;
	};
}

/**
 * Process-wide: a shared RPC host opens a fresh resource loader for every session, and each open
 * loaded every user skill twice (omo#11437). The stat the caller already took is the validator, so an
 * edited, replaced, or touched SKILL.md is read again on the next load and hot reload is unchanged.
 * Project skills never come here; their checked descriptor read stays per load.
 */
export const readUserSkillSource: ReadUserSkillSource = createSkillSourceCache();
