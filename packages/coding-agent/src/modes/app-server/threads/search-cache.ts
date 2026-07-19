import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "../../../config.ts";
import type { WireThread } from "./registry.ts";

export type SearchSessionRecord = {
	readonly thread: WireThread;
	readonly searchableText: string;
};

export type SearchCacheStats = {
	readonly hits: number;
	readonly misses: number;
	readonly entries: number;
};

type SearchCacheEntry = {
	readonly mtimeMs: number;
	readonly record: SearchSessionRecord;
};

const DEFAULT_MAX_ENTRIES = 512;

/**
 * Server-lifetime searchable text cache. The cache is bounded so a large
 * session directory cannot retain every transcript forever; a changed mtime
 * invalidates only that session's entry.
 */
export class ThreadSearchCache {
	private readonly entries = new Map<string, SearchCacheEntry>();
	private readonly maxEntries: number;
	private hits = 0;
	private misses = 0;

	constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
		this.maxEntries = Math.max(1, Math.trunc(maxEntries));
	}

	async load(sessionDir?: string): Promise<readonly SearchSessionRecord[]> {
		const directory = sessionDir ?? getSessionsDir();
		let names: readonly string[];
		try {
			names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
		} catch (error: unknown) {
			if (isNodeFsError(error) && error.code === "ENOENT") {
				return [];
			}
			throw error;
		}

		const records = await Promise.all(names.map((name) => this.loadFile(join(directory, name))));
		return records.filter(isSearchSessionRecord);
	}

	stats(): SearchCacheStats {
		return { hits: this.hits, misses: this.misses, entries: this.entries.size };
	}

	private async loadFile(path: string): Promise<SearchSessionRecord | null> {
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(path)).mtimeMs;
		} catch (error: unknown) {
			if (isNodeFsError(error) && error.code === "ENOENT") {
				this.entries.delete(path);
				return null;
			}
			throw error;
		}

		const cached = this.entries.get(path);
		if (cached?.mtimeMs === mtimeMs) {
			this.hits += 1;
			this.entries.delete(path);
			this.entries.set(path, cached);
			return cached.record;
		}

		this.misses += 1;
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch (error: unknown) {
			if (isNodeFsError(error) && error.code === "ENOENT") {
				this.entries.delete(path);
				return null;
			}
			throw error;
		}

		const record = parseSearchSession(path, mtimeMs, content);
		if (!record) {
			this.entries.delete(path);
			return null;
		}
		this.entries.delete(path);
		this.entries.set(path, { mtimeMs, record });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		return record;
	}
}

function parseSearchSession(path: string, mtimeMs: number, content: string): SearchSessionRecord | null {
	let header: SessionHeader | null = null;
	let name: string | null = null;
	let firstUserMessage: string | null = null;
	let lastActivityMs = mtimeMs;
	const messages: string[] = [];

	for (const line of content.split("\n")) {
		const entry = parseRecord(line);
		if (!entry) continue;
		if (!header) {
			header = parseHeader(entry);
			if (!header) return null;
			lastActivityMs = timestampMs(header.timestamp, mtimeMs);
			continue;
		}

		if (entry.type === "session_info") {
			name = typeof entry.name === "string" ? entry.name.trim() || null : null;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = recordValue(entry.message);
		if (!message) continue;
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = messageText(message.content);
		if (!text) continue;
		messages.push(text);
		if (role === "user" && firstUserMessage === null) {
			firstUserMessage = text;
		}
		lastActivityMs = Math.max(lastActivityMs, timestampMs(entry.timestamp, mtimeMs));
	}

	if (!header) return null;
	const createdAt = isoTimestamp(timestampMs(header.timestamp, mtimeMs));
	return {
		thread: {
			id: header.id,
			sessionId: header.id,
			sessionPath: path,
			cwd: header.cwd,
			createdAt,
			updatedAt: isoTimestamp(lastActivityMs),
			status: { type: "notLoaded" },
			preview: firstUserMessage,
			name,
		},
		searchableText: messages.join(" "),
	};
}

type SessionHeader = {
	readonly id: string;
	readonly cwd: string;
	readonly timestamp: string;
};

function parseHeader(value: Record<string, unknown>): SessionHeader | null {
	if (value.type !== "session") return null;
	const id = value.id;
	const cwd = value.cwd;
	const timestamp = value.timestamp;
	if (typeof id !== "string" || id.length === 0 || typeof cwd !== "string" || typeof timestamp !== "string") {
		return null;
	}
	return { id, cwd, timestamp };
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const value = recordValue(block);
			return value?.type === "text" && typeof value.text === "string" ? value.text : "";
		})
		.filter((text) => text.length > 0)
		.join(" ");
}

function parseRecord(line: string): Record<string, unknown> | null {
	if (!line.trim()) return null;
	try {
		const value: unknown = JSON.parse(line);
		return recordValue(value);
	} catch (error: unknown) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

function recordValue(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return Object.fromEntries(Object.entries(value));
}

function timestampMs(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function isoTimestamp(value: number): string {
	return new Date(value).toISOString();
}

function isSearchSessionRecord(value: SearchSessionRecord | null): value is SearchSessionRecord {
	return value !== null;
}

function isNodeFsError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}
