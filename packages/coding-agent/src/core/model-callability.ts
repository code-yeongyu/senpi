import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Persisted record of models that recently failed with an access-denied class
 * error (see retry-fallback/access-denied.ts). Marks expire after a TTL so a
 * model recovers automatically once the user fixes the out-of-band cause
 * (policy acknowledgment, plan change); a successful call also clears the mark.
 */

export const MODEL_CALLABILITY_TTL_MS = 24 * 60 * 60 * 1_000;

const STORE_VERSION = 1;

export type ModelCallabilityEntry = {
	readonly markedAt: number;
	readonly reason: string;
};

type StoredFile = {
	version?: unknown;
	entries?: unknown;
};

export class ModelCallabilityStore {
	private readonly filePath: string;
	private readonly now: () => number;
	private readonly ttlMs: number;
	private entries = new Map<string, ModelCallabilityEntry>();
	private loaded = false;

	constructor(agentDir: string, options?: { now?: () => number; ttlMs?: number }) {
		this.filePath = join(agentDir, "model-callability.json");
		this.now = options?.now ?? (() => Date.now());
		this.ttlMs = options?.ttlMs ?? MODEL_CALLABILITY_TTL_MS;
	}

	/** Load persisted marks; expired entries are pruned. Safe to fire and forget. */
	async load(): Promise<void> {
		let parsed: StoredFile;
		try {
			parsed = JSON.parse(await readFile(this.filePath, "utf8")) as StoredFile;
		} catch {
			this.loaded = true;
			return;
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.entries !== "object" ||
			parsed.entries === null
		) {
			this.loaded = true;
			return;
		}
		const now = this.now();
		for (const [selector, entry] of Object.entries(parsed.entries)) {
			if (typeof entry !== "object" || entry === null) continue;
			const { markedAt, reason } = entry as Record<string, unknown>;
			if (typeof markedAt !== "number" || !Number.isFinite(markedAt)) continue;
			if (now < markedAt || now - markedAt >= this.ttlMs) continue;
			this.entries.set(selector, { markedAt, reason: typeof reason === "string" ? reason : "access-denied" });
		}
		this.loaded = true;
	}

	/** Synchronous view for UI filtering; empty until load() settles. */
	unavailableSelectors(): ReadonlySet<string> {
		const now = this.now();
		const out = new Set<string>();
		for (const [selector, entry] of this.entries) {
			if (now >= entry.markedAt && now - entry.markedAt < this.ttlMs) out.add(selector);
		}
		return out;
	}

	isUnavailable(selector: string): boolean {
		return this.unavailableSelectors().has(selector);
	}

	async mark(selector: string, reason: string): Promise<void> {
		await this.ensureLoaded();
		this.entries.set(selector, { markedAt: this.now(), reason });
		await this.persist();
	}

	async unmark(selector: string): Promise<void> {
		await this.ensureLoaded();
		if (!this.entries.delete(selector)) return;
		await this.persist();
	}

	private async ensureLoaded(): Promise<void> {
		if (!this.loaded) await this.load();
	}

	private async persist(): Promise<void> {
		const now = this.now();
		const entries: Record<string, ModelCallabilityEntry> = {};
		for (const [selector, entry] of this.entries) {
			if (now >= entry.markedAt && now - entry.markedAt < this.ttlMs) entries[selector] = entry;
		}
		try {
			await mkdir(dirname(this.filePath), { recursive: true });
			await writeFile(this.filePath, `${JSON.stringify({ version: STORE_VERSION, entries }, null, 2)}\n`, "utf8");
		} catch {
			// A read-only agent dir must not break the session; marks stay in-memory.
		}
	}
}
