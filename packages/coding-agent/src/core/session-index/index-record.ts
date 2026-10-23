import type { FileEntry } from "../session-manager.ts";

export interface IndexedUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
}

/**
 * One JSONL line of a session, without its body (senpi#3968): where the line is (UTF-8 byte offset and length,
 * newline excluded), its place in the tree, and the few small fields the session's whole-history state is built
 * from. Message text, reasoning, tool arguments and output, images and custom data never enter a record.
 */
export interface IndexedEntry {
	readonly offset: number;
	readonly length: number;
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly role?: string;
	readonly customType?: string;
	/** The raw line contains a tool_search activation marker, so the activation history is found without a parse. */
	readonly activationMarker?: true;
	readonly firstKeptEntryId?: string;
	readonly usage?: IndexedUsage;
	/** For `label` entries: the target, the label (undefined clears it) and when it was set. */
	readonly targetId?: string;
	readonly label?: string;
	readonly timestamp?: string;
	/** For `session_info` entries: the session name (an empty name clears it). */
	readonly name?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function usageOf(entry: FileEntry): IndexedUsage | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
	const { usage } = entry.message;
	if (!usage) return undefined;
	return {
		input: count(usage.input),
		output: count(usage.output),
		cacheRead: count(usage.cacheRead),
		cacheWrite: count(usage.cacheWrite),
		cost: count(usage.cost?.total),
	};
}

/**
 * Exact for parsed JSON: the prefix holds no character JSON escapes, so it occurs in a line only where a key or string
 * value contains it, the same test `mayHoldActivationMarker` makes on the parsed entry (senpi#3518).
 */
const ACTIVATION_MARKER = Buffer.from("[tool_search:activated");

export function indexRecordOf(entry: FileEntry, offset: number, line: Buffer): IndexedEntry {
	const length = line.length;
	const marked = line.includes(ACTIVATION_MARKER) ? { activationMarker: true as const } : {};
	const base = { offset, length, type: entry.type, id: entry.id, ...marked };
	if (entry.type === "session") return { ...base, parentId: null };
	const parentId = entry.parentId ?? null;
	switch (entry.type) {
		case "message": {
			const usage = usageOf(entry);
			const role = text(entry.message.role);
			return {
				...base,
				parentId,
				...(role === undefined ? {} : { role }),
				...(usage === undefined ? {} : { usage }),
			};
		}
		case "compaction":
			return { ...base, parentId, firstKeptEntryId: entry.firstKeptEntryId };
		case "label":
			return {
				...base,
				parentId,
				targetId: entry.targetId,
				timestamp: entry.timestamp,
				...(entry.label === undefined ? {} : { label: entry.label }),
			};
		case "session_info":
			return { ...base, parentId, ...(entry.name === undefined ? {} : { name: entry.name }) };
		case "custom":
		case "custom_message": {
			const customType = text(entry.customType);
			return { ...base, parentId, ...(customType === undefined ? {} : { customType }) };
		}
		default:
			return { ...base, parentId };
	}
}
