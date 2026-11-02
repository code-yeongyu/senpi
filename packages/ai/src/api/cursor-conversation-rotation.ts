import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_CURSOR_CONVERSATION_ROTATIONS = 3;
export const MAX_CURSOR_CONVERSATION_ROTATION_RECORDS = 512;
export const CURSOR_CONVERSATION_POISONED_MESSAGE =
	"Cursor conversation is poisoned for this session; use another provider";

const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/i;

export type ConversationRotationRecord = {
	readonly wireId: string;
	readonly poisonCount: number;
	readonly skip: boolean;
	/**
	 * A 0-token RE was already surfaced to the session layer for this base
	 * conversation, so compaction has had its turn and rotation may proceed.
	 */
	readonly surfaced: boolean;
};

export type PoisonDecision = { readonly kind: "rotated"; readonly wireId: string } | { readonly kind: "exhausted" };

type MutableRecord = {
	wireId: string;
	poisonCount: number;
	skip: boolean;
	surfaced: boolean;
};

export type ConversationRotationStore = {
	getWireId(baseId: string): string;
	shouldSkip(baseId: string): boolean;
	/**
	 * True until a 0-token RE has been surfaced once for `baseId`. The first
	 * failure must reach the session layer so compact-before-rotate can shrink
	 * an oversized payload; only after that is rotation the right remedy.
	 */
	shouldSurfaceBeforeRotating(baseId: string): boolean;
	markSurfaced(baseId: string, currentWireId: string): void;
	recordZeroTokenPoison(baseId: string, currentWireId: string): PoisonDecision;
	/** Number of retained records (bounded; diagnostics for #1024). */
	recordCount(): number;
};

export function isZeroTokenResourceExhausted(errorMessage: string, sawTokenDelta: boolean): boolean {
	return !sawTokenDelta && RESOURCE_EXHAUSTED_PATTERN.test(errorMessage);
}

export function createConversationRotationStore(options: {
	readonly persistPath: string;
	readonly randomId?: () => string;
	readonly maxRecords?: number;
}): ConversationRotationStore {
	const randomId = options.randomId ?? randomUUID;
	const maxRecords =
		options.maxRecords ??
		readRotationRecordLimit(process.env.PI_CURSOR_ROTATION_RECORD_LIMIT) ??
		MAX_CURSOR_CONVERSATION_ROTATION_RECORDS;
	const records = loadRecords(options.persistPath);

	// #1024: records accumulate one per base conversation id for process
	// lifetime (and each persist rewrites the whole file). Object key order is
	// insertion order for these uuid-shaped ids, so the oldest records drop
	// first. Poison memory survives process restarts via the persisted file;
	// trimming only forgets the oldest ids, which re-derive cheaply (at most a
	// surfaced 0-token RE per id).
	const trimRecords = (): void => {
		const keys = Object.keys(records);
		for (let i = 0; i < keys.length - maxRecords; i++) delete records[keys[i]];
	};

	const persist = (): void => {
		trimRecords();
		mkdirSync(dirname(options.persistPath), { recursive: true });
		writeFileSync(options.persistPath, `${JSON.stringify(records, null, 2)}\n`);
	};

	return {
		getWireId(baseId: string): string {
			const existing = records[baseId];
			if (!existing) return baseId;
			if (!existing.skip) return existing.wireId;
			const wireId = randomId();
			existing.wireId = wireId;
			existing.skip = false;
			existing.poisonCount = 0;
			// A reminted id is a fresh conversation: it earns its own surface-first
			// pass so compaction runs again before rotation resumes.
			existing.surfaced = false;
			records[baseId] = existing;
			persist();
			return wireId;
		},
		shouldSkip(baseId: string): boolean {
			return records[baseId]?.skip === true;
		},
		shouldSurfaceBeforeRotating(baseId: string): boolean {
			return records[baseId]?.surfaced !== true;
		},
		markSurfaced(baseId: string, currentWireId: string): void {
			const existing = records[baseId] ?? {
				wireId: currentWireId,
				poisonCount: 0,
				skip: false,
				surfaced: false,
			};
			if (existing.surfaced) return;
			existing.surfaced = true;
			records[baseId] = existing;
			persist();
		},
		recordCount(): number {
			return Object.keys(records).length;
		},
		recordZeroTokenPoison(baseId: string, currentWireId: string): PoisonDecision {
			const existing = records[baseId] ?? {
				wireId: currentWireId,
				poisonCount: 0,
				skip: false,
				surfaced: false,
			};
			if (existing.skip || existing.poisonCount >= MAX_CURSOR_CONVERSATION_ROTATIONS) {
				existing.skip = true;
				existing.wireId = currentWireId;
				records[baseId] = existing;
				persist();
				return { kind: "exhausted" };
			}
			const wireId = randomId();
			existing.wireId = wireId;
			existing.poisonCount += 1;
			records[baseId] = existing;
			persist();
			return { kind: "rotated", wireId };
		},
	};
}

export function resolveConversationRotationPersistPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CURSOR_CONVERSATION_ID_STORE) {
		return env.CURSOR_CONVERSATION_ID_STORE;
	}
	const agentDir =
		env.SENPI_CODING_AGENT_DIR ?? env.CODING_AGENT_DIR ?? `${(env.HOME ?? ".").replace(/\/$/, "")}/.senpi/agent`;
	return `${agentDir.replace(/\/$/, "")}/cursor-conversation-ids.json`;
}

function readRotationRecordLimit(raw: string | undefined): number | undefined {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function loadRecords(persistPath: string): Record<string, MutableRecord> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(persistPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const records: Record<string, MutableRecord> = {};
		for (const [baseId, value] of Object.entries(parsed)) {
			if (!value || typeof value !== "object") continue;
			const raw = value as { wireId?: unknown; poisonCount?: unknown; skip?: unknown; surfaced?: unknown };
			if (typeof raw.wireId !== "string" || raw.wireId.length === 0) continue;
			records[baseId] = {
				wireId: raw.wireId,
				poisonCount: typeof raw.poisonCount === "number" && raw.poisonCount >= 0 ? raw.poisonCount : 0,
				skip: raw.skip === true,
				surfaced: raw.surfaced === true,
			};
		}
		return records;
	} catch {
		return {};
	}
}
