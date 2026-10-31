import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	SystemMessage,
	TextContent,
	ThinkingSelection,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, normalizeProviderId } from "@earendil-works/pi-ai";
import { randomBytes, randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { appendFile, type FileHandle, open, readdir, rm } from "fs/promises";
import { basename, join, resolve } from "path";
import { StringDecoder } from "string_decoder";
import { APP_NAME, getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { EventLoopSlicer, mapInSlices } from "./event-loop-slicer.ts";
import { projectRetainedMessages } from "./extensions/builtin/compaction/retained-message-projection.ts";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import type { InputSource } from "./extensions/types.ts";
import type { RecoveryCarrier } from "./session-recovery-identity.ts";
import type { ModelChangeOrigin, ModelChangeSource } from "./model-change-origin.ts";
import { sessionCwdMatcher } from "./moved-session-cwd.ts";
import type { RepositoryIdentity } from "./repository-identity.ts";
import {
	ALL_SESSION_LIST_PUBLISH_INTERVAL,
	listSessionFilesInDir,
	listSessionsFromDir,
	type SessionListProgress,
	sortSessionInfos,
} from "./session-discovery.ts";
import {
	loadEntriesFromFile,
	loadEntriesFromFileAsync,
	parseSessionEntryLine,
	readForkSource,
	terminateFinalSessionLine,
} from "./session-entry-file.ts";
import { materializeSessionEntries } from "./session-entry-materializer.ts";
import { captureAndCloseFileIdentity, captureFileIdentity, loadedFileIdentities } from "./session-file-identity.ts";
import { replaceFileAtomically } from "./session-file-replace.ts";
import { type HistoryReducer, HistoryReductions } from "./session-history-reduce.ts";
import type { SpawnedBy } from "./session-lifecycle-types.ts";
import { compactUpdatesEnabled } from "./engine-socket-flag.ts";
import { planLoadedTail } from "./session-loaded-tail.ts";
import {
	type FileIdentity,
	snapshotTranscript,
	TranscriptJournal,
	type TranscriptFlow,
	type TranscriptPersistence,
	type TranscriptTransition,
} from "./session-transcript-journal.ts";
import { branchFlow, compactionFlow, contextEditFlow, ownedFlowMessage } from "./session-transcript-flows.ts";
import { TranscriptFile } from "./session-transcript-file.ts";
import { SessionWriteGuard } from "./session-move/write-guard.ts";
import { type ResidentStoreStats, ResidentStringStore } from "./session-resident-store.ts";
import { SessionWriteFence } from "./session-write-fence.ts";
import {
	discardFailedFirstFlush,
	discardFailedFirstFlushAsync,
	type SessionRecovery,
	type SessionRecoveryCause,
	sessionRecoveryCause,
	truncateToLastCompleteLine,
} from "./session-write-recovery.ts";
import {
	hasOtherLiveSessionWriter,
	registerSessionWriter,
	reserveSessionWrite,
	unregisterSessionWriter,
} from "./session-write-reservation.ts";
import { isVirtualModel } from "./virtual-models.ts";

export type { SessionListProgress } from "./session-discovery.ts";
export { loadEntriesFromFile, loadEntriesFromFileAsync } from "./session-entry-file.ts";
export type { SessionRecovery, SessionRecoveryCause } from "./session-write-recovery.ts";

// Fork change: inlined UUIDv7 (upstream uses the `uuid` npm package). Keeps this
// package self-contained so consumers don't need a transitive `uuid` install.
function uuidv7(): string {
	const ts = BigInt(Date.now());
	const bytes = randomBytes(10);
	const hex = [
		((ts >> 40n) & 0xffn).toString(16).padStart(2, "0"),
		((ts >> 32n) & 0xffn).toString(16).padStart(2, "0"),
		((ts >> 24n) & 0xffn).toString(16).padStart(2, "0"),
		((ts >> 16n) & 0xffn).toString(16).padStart(2, "0"),
		((ts >> 8n) & 0xffn).toString(16).padStart(2, "0"),
		(ts & 0xffn).toString(16).padStart(2, "0"),
		(0x70 | (bytes[0]! & 0x0f)).toString(16).padStart(2, "0"),
		bytes[1]!.toString(16).padStart(2, "0"),
		(0x80 | (bytes[2]! & 0x3f)).toString(16).padStart(2, "0"),
		bytes[3]!.toString(16).padStart(2, "0"),
		...Array.from(bytes.slice(4), (b) => b.toString(16).padStart(2, "0")),
	].join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

import {
	type BashExecutionMessage,
	type ConfigurationUpdateMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";

/**
 * Whether `value` is plain JSON: null, booleans, finite numbers, strings, arrays of those, and objects
 * with a plain prototype. Object properties that are undefined are allowed (JSON omits them and reading
 * them gives undefined either way); an undefined array element is not (JSON turns it into null).
 */
function isPlainJson(value: unknown, depth = 0): boolean {
	if (depth > 64) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		// A plain loop, not every(): every() skips holes in a sparse array, which JSON turns into null.
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			if (item === undefined || !isPlainJson(item, depth + 1)) return false;
		}
		return true;
	}
	if (typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	for (const item of Object.values(value)) {
		if (item !== undefined && !isPlainJson(item, depth + 1)) return false;
	}
	return true;
}

const contextMessageEntryIds = new WeakMap<object, string>();

/** Request-local field carried across context hooks; never persisted or sent to providers. */
export const SESSION_CONTEXT_ENTRY_ID = "__piSessionContextEntryId";

function withContextEntryId<T extends AgentMessage>(entryId: string, message: T): T {
	contextMessageEntryIds.set(message, entryId);
	return message;
}

/** Entry identity for a transient message projected from session history. */
export function getSessionContextEntryId(message: AgentMessage): string | undefined {
	return contextMessageEntryIds.get(message);
}

/**
 * Copy a message's context entry identity onto a derived message object. Context
 * pipeline stages that spread messages call this so checkpoint provenance (the
 * openai-remote replay boundary) survives both the cloned and the shared-transcript
 * context-hook paths. The derived object gets the id both in the WeakMap (matching
 * originals) and as the own enumerable property it would have carried via spread on
 * the clone path — the source is only read, never written (senpi#2525).
 */
export function inheritSessionContextEntryId<T extends AgentMessage>(derived: T, source: AgentMessage): T {
	const fromProperty = Object.getOwnPropertyDescriptor(source, SESSION_CONTEXT_ENTRY_ID)?.value;
	const entryId = getSessionContextEntryId(source) ?? (typeof fromProperty === "string" ? fromProperty : undefined);
	if (entryId === undefined) return derived;
	contextMessageEntryIds.set(derived, entryId);
	Object.assign(derived, { [SESSION_CONTEXT_ENTRY_ID]: entryId });
	return derived;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Some summed turn had no known price, so `cost` is a lower bound (senpi#3844). */
	costUnknown?: true;
	latestCacheHitRate: number | undefined;
}

function emptyUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined };
}

export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	/** Execution ancestry, unlike parentSession's transcript/fork provenance. */
	spawnedBy?: SpawnedBy;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
	spawnedBy?: SpawnedBy;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
	/**
	 * Where a user message came from: the `source` its `input` event reported. Stored on the entry, never on
	 * the message, so it stays in the session record and out of provider requests. Absent on every other
	 * entry and on user input that ran no `input` event (restored, moved or edited input): unknown origin.
	 */
	inputSource?: InputSource;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
	/** Explicit selector provenance. Omitted by legacy entries and SDK-defaulted fallbacks. */
	thinkingSelection?: ThinkingSelection;
	/** Source of a model switch or explicit thinking-level request, including RPC requests without an effectId. */
	triggerSource?: ModelChangeSource;
	triggerActor?: string;
	/** The RPC model or thinking-level effect that applied this value. */
	effectId?: string;
	/** Model the level applied to (senpi#3819); absent on older entries. Feeds the per-session per-model map. */
	provider?: string;
	modelId?: string;
}

export interface ConfigurationUpdateEntry extends SessionEntryBase {
	type: "configuration_update";
	reasoning: { effort: string };
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
	/** Transient fallback changes are excluded from restored session defaults. */
	reason?: "fallback" | "fallback-revert";
	/** The model active before a fallback window, retained for restart restoration. */
	originalProvider?: string;
	originalModelId?: string;
	/** What made the switch (senpi#2870); omitted by entries written before it was recorded. */
	source?: ModelChangeSource;
	/** Who issued it, where known: an extension path, an RPC client, the picker used. */
	actor?: string;
	/** The switch landed while a turn was streaming. */
	duringTurn?: boolean;
	/** The RPC `effectId` that asked for the switch, so a reopen can tell the receipt was applied. */
	effectId?: string;
}

/**
 * A model switch the session refused. Recorded because the refusal happens
 * before any `model_change` is appended, which left an attempted-and-rejected
 * switch indistinguishable from one the user never made (#1526).
 *
 * Durability follows the shared session-file contract, it is not special-cased:
 * `_persist` buffers every entry until the branch holds a user or assistant
 * message (#10000), so a refusal recorded before the session's first message
 * reaches the JSONL only when that message flushes the buffer. A session that
 * never gets one keeps the record in memory for its lifetime and never writes a file.
 */
export interface ModelChangeRejectedEntry extends SessionEntryBase {
	type: "model_change_rejected";
	provider: string;
	modelId: string;
	reason: "context-budget" | "auth";
	/**
	 * The guard's own explanation, including its remedy. Named `detail` rather
	 * than `message` so this entry stays structurally distinct from
	 * `SessionMessageEntry`, whose `message` is an object.
	 */
	detail: string;
	/** Budget numbers; present only for the context-budget reason. */
	contextWindow?: number;
	liveContextTokens?: number;
	requiredTokens?: number;
	shortfallTokens?: number;
	safetyMarginProfile?: string;
}

export interface UsageEntry extends SessionEntryBase {
	type: "usage";
	/** Arbitrary usage category, such as "cache_warm". */
	kind: string;
	provider: string;
	model: string;
	usage: Usage;
	/** Optional human-readable qualifier for usage notices. */
	note?: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Usage from the LLM call(s) that generated this summary, if available */
	usage?: Usage;
	/** True if generated by an extension, undefined/false if pi-generated (backward compatible) */
	fromHook?: boolean;
	/** Complete prompt and tool state at this compaction boundary. */
	systemMessage?: SystemMessage;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Extension-specific data (not sent to LLM) */
	details?: T;
	/** Usage from the LLM call that generated this summary, if available */
	usage?: Usage;
	/** True if generated by an extension, false if pi-generated */
	fromHook?: boolean;
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context (ignored by buildSessionContext).
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
	/** Written at session start without user action; see `AppendEntryOptions.startupBookkeeping` (senpi#3263). */
	startupBookkeeping?: true;
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** Session metadata entry (e.g., user-defined display name). */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context.
 * The content is converted to a user message in buildSessionContext().
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

/** Content that an append-only context edit may replace without changing message metadata. */
export type ContextEditableContent =
	| UserMessage["content"]
	| AssistantMessage["content"]
	| ToolResultMessage["content"]
	| CustomMessage["content"];

/** Append-only change to one earlier entry's contribution to model context. */
export interface ContextEditEntry extends SessionEntryBase {
	type: "context_edit";
	targetId: string;
	/** Null omits the target from model context. A value replaces only its content. */
	replacement: { content: ContextEditableContent } | null;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ConfigurationUpdateEntry
	| ModelChangeEntry
	| ModelChangeRejectedEntry
	| UsageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| ContextEditEntry
	| LabelEntry
	| SessionInfoEntry;

/** Raw file entry (includes header) */
export type FileEntry = SessionHeader | SessionEntry;

type MaterializedView = { readonly source: FileEntry[]; readonly length: number; readonly entries: SessionEntry[] };

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
	/** Timestamp of the latest label change for this entry, if any */
	labelTimestamp?: string;
}

export interface ProjectedSessionEntry {
	/** Raw append-only entry that owns this projected contribution. */
	sourceEntry: SessionEntry;
	/** Model-visible messages after context edits. Empty for state-only entries and omissions. */
	messages: AgentMessage[];
}

export interface SessionProjection {
	entries: ProjectedSessionEntry[];
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	thinkingSelection?: ThinkingSelection;
	configurationUpdate?: { effort: string };
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	/** Latest repository identity the session recorded (see `repository-identity`). */
	repositoryIdentity?: RepositoryIdentity;
	/** Set on sessions of the current repository recorded at a path that no longer exists. */
	moved?: boolean;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getFullBranch"
	| "buildContextEntries"
	| "buildSessionContext"
	| "buildSessionProjection"
	| "getHeader"
	| "getEntries"
	| "reduceHistory"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

const SESSION_FILE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(.+)\.jsonl$/;

/** The id a session file's name carries (`<timestamp>_<id>.jsonl`), when the name has that shape and the id is valid. */
export function sessionFileNameId(path: string): string | undefined {
	const id = SESSION_FILE_NAME.exec(basename(path))?.[1];
	if (id === undefined) return undefined;
	try {
		assertValidSessionId(id);
		return id;
	} catch {
		return undefined;
	}
}

function withFileNameId(path: string, options: NewSessionOptions | undefined): NewSessionOptions | undefined {
	if (options?.id !== undefined) return options;
	const id = sessionFileNameId(path);
	return id === undefined ? options : { ...options, id };
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	leaf ??= entries[entries.length - 1];
	if (!leaf) {
		return [];
	}

	const path: SessionEntry[] = [];
	const visited = new Set<SessionEntry>();
	let current: SessionEntry | undefined = leaf;
	// A file with a reused id has a cycle in its parent chain; stop at the first revisit so the
	// session still opens instead of walking forever.
	while (current && !visited.has(current)) {
		visited.add(current);
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function getSessionContextSettings(
	path: SessionEntry[],
): Pick<SessionContext, "thinkingLevel" | "thinkingSelection" | "configurationUpdate" | "model"> {
	let thinkingLevel = "off";
	let thinkingSelection: ThinkingSelection | undefined;
	let configurationUpdate: { effort: string } | undefined;
	let model: { provider: string; modelId: string } | null = null;
	// An explicit selection (a manual `model_change`, or the primary restored from a fallback
	// window) outranks the model id echoed by later assistant messages from the SAME provider:
	// the persisted message id is the wire id, which differs from the catalog id whenever the
	// catalog entry maps to an `upstreamModelId` (a `-fast` priority variant is the common case),
	// so trusting the echo would resume the base model and silently drop the tier. A message
	// from another provider still wins, since no `model_change` recorded that hop.
	let isModelSelectionExplicit = false;
	let isInFallbackWindow = false;
	// A fallback switch applies an ephemeral thinking level to the fallback model, so
	// the level recorded inside the window must not outlive it: restoring the primary
	// model with the fallback model's level would silently change the reasoning budget.
	// Mirrors the model restoration above, including the never-reverted (crashed) case.
	let preFallbackThinkingLevel = thinkingLevel;
	let preFallbackThinkingSelection = thinkingSelection;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
			thinkingSelection = entry.thinkingSelection;
		} else if (entry.type === "configuration_update") {
			configurationUpdate = { effort: entry.reasoning.effort };
		} else if (entry.type === "model_change") {
			if (entry.reason === "fallback") {
				if (!isInFallbackWindow) {
					preFallbackThinkingLevel = thinkingLevel;
					preFallbackThinkingSelection = thinkingSelection;
					if (entry.originalProvider && entry.originalModelId) {
						// Read boundary (senpi#1989): a session recorded by an earlier
						// version carries the legacy provider id, so normalize on read.
						// No rewrite is added here.
						model = { provider: normalizeProviderId(entry.originalProvider), modelId: entry.originalModelId };
						isModelSelectionExplicit = true;
					}
				}
				isInFallbackWindow = true;
			} else if (entry.reason === "fallback-revert") {
				if (isInFallbackWindow) {
					thinkingLevel = preFallbackThinkingLevel;
					thinkingSelection = preFallbackThinkingSelection;
				}
				isInFallbackWindow = false;
			} else {
				// A manual model switch abandons the window: the level the user set inside
				// it is a deliberate choice and carries over to the newly selected model.
				isInFallbackWindow = false;
				// Session files are parsed without validation, so an entry missing its provider or
				// model id must not become an authoritative selection; the fallback-original restore
				// above guards the same way, and a later assistant message still restores the model.
				if (entry.provider && entry.modelId) {
					model = { provider: normalizeProviderId(entry.provider), modelId: entry.modelId };
					isModelSelectionExplicit = true;
				}
			}
		} else if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			!isInFallbackWindow &&
			// A failed routing attempt names the virtual model; no model answered it.
			!isVirtualModel(entry.message)
		) {
			if (isModelSelectionExplicit && model?.provider === normalizeProviderId(entry.message.provider)) continue;
			model = { provider: normalizeProviderId(entry.message.provider), modelId: entry.message.model };
			isModelSelectionExplicit = false;
		}
	}

	// The process can exit inside a fallback window; the primary model is already
	// restored above, so its pre-fallback level has to be restored with it.
	if (isInFallbackWindow) {
		thinkingLevel = preFallbackThinkingLevel;
		thinkingSelection = preFallbackThinkingSelection;
	}

	return { thinkingLevel, thinkingSelection, configurationUpdate, model };
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		// Session files are parsed without validation; old versions, forks, or
		// hand-edited files can contain messages with null/missing content.
		if (message.role === "system" && message.content == null) return [{ ...message, content: "" }];
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [withContextEntryId(entry.id, { ...message, content: [] })];
		}
		return [withContextEntryId(entry.id, message)];
	}
	if (entry.type === "configuration_update") {
		return [
			withContextEntryId(entry.id, {
				role: "configurationUpdate",
				content: [],
				effort: entry.reasoning.effort,
				timestamp: new Date(entry.timestamp).getTime(),
			} satisfies ConfigurationUpdateMessage),
		];
	}
	if (entry.type === "custom_message") {
		return [
			withContextEntryId(
				entry.id,
				createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
			),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [withContextEntryId(entry.id, createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp))];
	}
	if (entry.type === "compaction") {
		const summary = withContextEntryId(
			entry.id,
			createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp, entry.details),
		);
		return entry.systemMessage ? [withContextEntryId(entry.id, entry.systemMessage), summary] : [summary];
	}
	return [];
}

/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	return contextEntriesOfPath(buildSessionPath(entries, leafId, byId));
}

function contextEntriesOfPath(path: SessionEntry[]): SessionEntry[] {
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		// The latest summary supersedes every older compaction summary. Older
		// entries selected by firstKeptEntryId remain verbatim, but nesting a
		// prior summary here would double-count it in the model context.
		if (entry.type === "compaction") continue;
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {
	const messages = sessionEntryToContextMessages(entry);
	if (!edit) return messages;
	const replacement = edit.replacement;
	if (replacement === null) return [];

	return messages.map((message) => {
		if (
			message.role !== "user" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "custom"
		) {
			return message;
		}
		const content =
			(message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
				? [{ type: "text" as const, text: replacement.content }]
				: replacement.content;
		// The edited copy keeps the entry identity of the message it replaces.
		return withContextEntryId(entry.id, { ...message, content } as AgentMessage);
	});
}

/** One pass over the path: the projection plus the fork's full context settings. */
function projectSession(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	knownPath?: SessionEntry[],
): { projection: SessionProjection; settings: ReturnType<typeof getSessionContextSettings> } {
	const path = knownPath ?? buildSessionPath(entries, leafId, byId);
	const settings = getSessionContextSettings(path);
	const contextEntries = contextEntriesOfPath(path);
	const edits = new Map<string, ContextEditEntry>();
	for (const entry of contextEntries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}
	const projectedEntries = contextEntries.map(
		(sourceEntry, index): ProjectedSessionEntry => ({
			sourceEntry,
			// buildContextEntries() may retain an older compaction entry because its
			// raw ID lies inside the newest retained range. Only the newest compaction
			// at index zero contributes a checkpoint and summary.
			messages:
				sourceEntry.type === "compaction" && index > 0
					? []
					: projectContextEntry(sourceEntry, edits.get(sourceEntry.id)),
		}),
	);
	const recoveryIndex = path.findLastIndex(
		(entry) =>
			entry.type === "compaction" &&
			entry.details !== null &&
			typeof entry.details === "object" &&
			"retainedMessagePolicy" in entry.details &&
			entry.details.retainedMessagePolicy === "omit-unsafe-v1",
	);
	if (recoveryIndex >= 0) {
		// Only entries retained by this checkpoint are repaired. Later messages
		// retain their normal semantics, and the source transcript is never edited.
		const retainedIds = new Set(path.slice(0, recoveryIndex).map((entry) => entry.id));
		const retained = projectedEntries.filter((entry) => retainedIds.has(entry.sourceEntry.id));
		const repaired = projectRetainedMessages(retained.flatMap((entry) => entry.messages));
		let index = 0;
		for (const entry of retained) {
			entry.messages = entry.messages.map(() => withContextEntryId(entry.sourceEntry.id, repaired[index++]));
		}
	}
	return {
		projection: {
			entries: projectedEntries,
			messages: projectedEntries.flatMap((entry) => entry.messages),
			thinkingLevel: settings.thinkingLevel,
			model: settings.model,
		},
		settings,
	};
}

/** Build provenance-preserving, compaction-aware model context. */
export function buildSessionProjection(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionProjection {
	return projectSession(entries, leafId, byId).projection;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction, branch summaries and context edits along the path: the messages are the
 * canonical session projection's.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const { projection, settings } = projectSession(entries, leafId, byId);
	const { thinkingLevel, thinkingSelection, model, configurationUpdate } = settings;
	return { messages: projection.messages, thinkingLevel, thinkingSelection, model, configurationUpdate };
}

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.senpi/agent/sessions/.
 */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and custom metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

/**
 * Inspect a physical line while searching for the first parsed session entry.
 * Blank and malformed lines are skipped to match loadEntriesFromFile().
 * Returns undefined to keep scanning, null for a parsed non-header entry, or the header.
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// Probe for EOF so a final header without a newline is allowed when it ends
		// exactly at the scan limit. Any additional byte exceeds the bounded scan.
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// Discovery is best-effort: unreadable or oversized files are not sessions,
		// and one corrupt file must not prevent other sessions from being found.
		return null;
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

interface OpenHeaderDiscovery {
	header: SessionHeader | null;
	/** The bounded header scan gave up: only a full load can find the header. */
	needsFullLoad: boolean;
}

function discoverOpenHeader(resolvedPath: string, cwdOverride: string | undefined): OpenHeaderDiscovery {
	if (cwdOverride !== undefined || !existsSync(resolvedPath)) return { header: null, needsFullLoad: false };
	try {
		return { header: readSessionHeader(resolvedPath), needsFullLoad: false };
	} catch (error) {
		if (!(error instanceof SessionHeaderScanLimitError)) throw error;
		return { header: null, needsFullLoad: true };
	}
}

function headerOf(entries: FileEntry[] | undefined): SessionHeader | null {
	const firstEntry = entries?.[0];
	return firstEntry?.type === "session" ? firstEntry : null;
}

function openLocation(
	resolvedPath: string,
	sessionDir: string | undefined,
	cwdOverride: string | undefined,
	header: SessionHeader | null,
): { cwd: string; dir: string } {
	// The header keeps the cwd it was recorded with; a folder the OmO desktop moved opens where it lives now,
	// and the file is never rewritten (senpi#2990).
	const headerCwd = header ? getSessionHeaderCwd(header) : undefined;
	const cwd = cwdOverride ?? (headerCwd ? resolveMovedPath(headerCwd) : headerCwd) ?? process.cwd();
	// If no sessionDir provided, derive from file's parent directory
	const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
	return { cwd, dir };
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const matchesCwd = cwd ? sessionCwdMatcher(resolvePath(cwd)) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(resolvedSessionDir, file))
			.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);

		for (const { path } of files) {
			const header = readSessionHeaderForDiscovery(path);
			if (header && (!matchesCwd || matchesCwd(getSessionHeaderCwd(header)))) return path;
		}
		return null;
	} catch {
		// Directory access and stat races make recent-session discovery unavailable.
		return null;
	}
}

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
let sessionEntryLoader = loadEntriesFromFile;

const DEFERRED_FILE_LOAD = Symbol("deferred-session-file-load");

/** Test seam for observing disk reloads without mocking ESM filesystem exports. */
export function setSessionEntryLoaderForTesting(loader: typeof loadEntriesFromFile): () => void {
	const previous = sessionEntryLoader;
	sessionEntryLoader = loader;
	return () => {
		sessionEntryLoader = previous;
	};
}

/** Setup entries: a file this process created that holds only these is disposable (senpi#3263). */
const SETUP_ENTRY_TYPES: ReadonlySet<FileEntry["type"]> = new Set([
	"session",
	"model_change",
	"model_change_rejected",
	"thinking_level_change",
	"configuration_update",
	"label",
]);

/** Engine lifecycle bookkeeping (senpi#3864): durable before any conversation, disposable without one. */
const LIFECYCLE_ENTRY_TYPES: ReadonlySet<string> = new Set(["session-lifecycle", "work-custody", "child-lifecycle"]);

/** A `custom` entry is disposable when its writer marked it as startup bookkeeping (senpi#3263) or it is lifecycle bookkeeping. */
function isDisposableEntry(entry: FileEntry): boolean {
	if (entry.type === "custom") return entry.startupBookkeeping === true || LIFECYCLE_ENTRY_TYPES.has(entry.customType);
	return SETUP_ENTRY_TYPES.has(entry.type);
}

/** A user or assistant message: the first one makes a new session worth a file (#10000). */
function isConversationEntry(entry: FileEntry): boolean {
	return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}

export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private readonly writeGuard = new SessionWriteGuard();
	private readonly writeFence = new SessionWriteFence();
	private flushed: boolean = false;
	private headerWrite: Promise<void> | undefined;
	// The file persistHeaderNow() created in this process; only it may be discarded on close (senpi#3263).
	private ownedHeaderFile: string | undefined;
	// Set when an append to the flushed file failed and may have left a partial last line.
	private tailMayBeTorn = false;
	/** Why the tail may be torn, for the notice the person gets when it is set aside. */
	private tornTailCause: SessionRecoveryCause = "unknown";
	private readonly pendingRecoveries: SessionRecovery[] = [];
	private recoveryListener: ((recovery: SessionRecovery) => void) | undefined;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	// Runtime-only identity tracking lets AgentSession compare messages to a
	// compaction boundary by append order rather than provider timestamps.
	// Materialized persisted messages are bound as they are read; only pending
	// messages that have not reached a session entry use AgentSession's fallback.
	private entryOrdersById: Map<string, number> = new Map();
	private messageEntryPositions = new WeakMap<AgentMessage, { entryId: string; order: number }>();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	// The persisted base of the last load or rewrite, and how many history entries it holds (R3.C1.1).
	private readonly transcriptFile = new TranscriptFile();
	private transcriptJournal: TranscriptJournal | undefined;
	private transcriptBytes = new WeakMap<FileEntry, string>();
	private readonly capturesTranscriptBase = compactUpdatesEnabled();
	private residentStore = new ResidentStringStore();
	private mirrorTrimmed = false;
	// Set while a navigation to an entry outside the mirror reloads the whole file into it.
	private loadingFullMirror = false;
	/**
	 * Ids of entries a compaction trimmed from the resident mirror. They are still in the session file,
	 * so a new entry must not reuse one: a reused id turns the file's parent chain into a cycle and the
	 * next resume never finishes opening the session.
	 */
	private trimmedIds = new Set<string>();
	private readonly idsInUse = { has: (id: string): boolean => this.byId.has(id) || this.trimmedIds.has(id) };
	// Counts loaded/appended entries, including those removed from the resident mirror.
	private fullEntryCount = 0;
	// Bumped whenever the history is replaced (not on append or mirror trim); keys `reduceHistory`'s memo.
	private historyGeneration = 0;
	// The mirror's last `fullEntryCount - verbatimFromCount` entries are the history's own tail, in order; a trim
	// leaves entries before them only on disk.
	private verbatimFromCount = 0;
	private readonly historyReductions = new HistoryReductions({
		generation: () => this.historyGeneration,
		count: () => this.fullEntryCount,
		appendedSince: (count) => this._appendedSince(count),
		readAll: () => this._readWholeHistory(),
	});
	private compactEntriesCache: { mutation: number; entries: SessionEntry[] } | null = null;
	/**
	 * Materialized views of `fileEntries` (`compact`) and, once the mirror is trimmed, of the full
	 * persisted history (`history`). Keyed by the mirror array and its length: appends push onto the
	 * same array, so a view extends by materializing only the new tail, while anything that rebuilds
	 * the mirror assigns a new array and invalidates both. Context builds run several times per turn;
	 * without this each one re-copied every entry of the session.
	 */
	private compactView: MaterializedView | null = null;
	private projectionMemo: {
		readonly source: SessionEntry[];
		readonly leafId: string | null;
		readonly path: SessionEntry[];
		readonly result: ReturnType<typeof projectSession>;
	} | null = null;
	private historyView: MaterializedView | null = null;
	/** Id -> entry of the compact view, extended with it, so the branch shares its materialized objects. */
	private compactLookup: { entries: SessionEntry[]; length: number; map: Map<string, SessionEntry> } | null = null;
	// Monotonic counter bumped by every mutator; memoized materialized views are
	// keyed on it so read hot paths (footer, RPC) never re-materialize unchanged sessions.
	private mutationCount = 0;
	private entriesCache: { mutation: number; entries: SessionEntry[] } | null = null;
	private branchCache: {
		leafId: string | null;
		mutation: number;
		entries: SessionEntry[];
		source: FileEntry[];
	} | null = null;
	private sessionNameCache: string | undefined = undefined;
	// Running usage totals over ALL entries (not branch-scoped), maintained
	// incrementally on assistant-message append and rebuilt from scratch in
	// _buildIndex()/newSession. Usage fields are numeric and unaffected by
	// string externalization, so the resident form can be read directly.
	private usageTotals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		latestCacheHitRate: undefined,
	};

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[] | typeof DEFERRED_FILE_LOAD,
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		// A persisted manager owns its session file for as long as it lives; the shared
		// RPC host reads this registry to release grants no writer holds anymore.
		if (persist) registerSessionWriter(this);
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}
		// Lazily resolved: the session id only exists once the header loads or
		// newSession() runs. Unpersisted sessions disable eviction entirely —
		// dropping strings with no backing would lose them.
		this.residentStore.configure({
			blobsDir: () =>
				this.persist && this.sessionId ? join(this.sessionDir, "resident-blobs", this.sessionId) : undefined,
		});

		if (sessionFile) {
			// `openAsync` loads the file itself, in slices, once construction returns.
			if (preloadedFileEntries !== DEFERRED_FILE_LOAD)
				this._setSessionFile(sessionFile, preloadedFileEntries, newSessionOptions);
		} else if (preloadedFileEntries !== DEFERRED_FILE_LOAD && preloadedFileEntries?.length) {
			this._loadEntries(preloadedFileEntries, newSessionOptions);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	/**
	 * Reload session entries from the session file on disk.
	 */
	reloadFromDisk(): void {
		if (!this.sessionFile || !existsSync(this.sessionFile)) return;

		// A live session file can be observed between truncate and rewrite. Treat
		// that window (and an invalid replacement) as unavailable rather than
		// routing it through the create/recover path in _setSessionFile().
		const fileEntries = loadEntriesFromFile(this.sessionFile, this.capturesTranscriptBase);
		if (fileEntries.length === 0) {
			if (statSync(this.sessionFile).size === 0) return;
			throw new Error(`Session file is not a valid ${APP_NAME} session: ${this.sessionFile}`);
		}
		this._setSessionFile(this.sessionFile, fileEntries);
		this._journalReplace();
	}

	/** Brings `id` back into the mirror by reloading the whole file when the mirror does not hold it. */
	private _loadFullMirrorFor(id: string): void {
		if (this.byId.has(id) || !this.sessionFile) return;
		this.loadingFullMirror = true;
		try {
			this.reloadFromDisk();
		} finally {
			this.loadingFullMirror = false;
		}
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
		this._journalReplace();
	}

	private _setSessionFile(
		sessionFile: string,
		preloadedFileEntries?: FileEntry[],
		newSessionOptions?: NewSessionOptions,
	): void {
		const existingFile = this._beginSessionFile(sessionFile, newSessionOptions);
		if (existingFile === undefined) return;
		const entries = preloadedFileEntries ?? loadEntriesFromFile(existingFile, this.capturesTranscriptBase);
		this._captureTranscriptBase(loadedFileIdentities.get(entries), entries);
		if (!this._adoptFileEntries(existingFile, entries, newSessionOptions)) return;
		const loadedHistory = this._retainLoadedTail();
		this.fileEntries = this.fileEntries.map((entry) => this.residentStore.externalize(entry));
		this._completeFileLoad(loadedHistory);
	}

	/**
	 * `_setSessionFile` for a host that shares its event loop: the same steps, with the
	 * transcript-sized parse and externalize run in slices that yield (senpi#3518).
	 */
	private async _setSessionFileAsync(
		sessionFile: string,
		preloadedFileEntries: FileEntry[] | undefined,
		newSessionOptions: NewSessionOptions | undefined,
		slicer: EventLoopSlicer,
	): Promise<void> {
		const existingFile = this._beginSessionFile(sessionFile, newSessionOptions);
		if (existingFile === undefined) return;
		const entries =
			preloadedFileEntries ?? (await loadEntriesFromFileAsync(existingFile, slicer, this.capturesTranscriptBase));
		this._captureTranscriptBase(loadedFileIdentities.get(entries), entries);
		if (!this._adoptFileEntries(existingFile, entries, newSessionOptions)) return;
		const loadedHistory = this._retainLoadedTail();
		this.fileEntries = await mapInSlices(this.fileEntries, (entry) => this.residentStore.externalize(entry), slicer);
		this._completeFileLoad(loadedHistory);
		await this.transcriptFile.ready;
	}

	/** Points this manager at `sessionFile`; the path when it exists, undefined when a new session was started there. */
	private _beginSessionFile(sessionFile: string, newSessionOptions?: NewSessionOptions): string | undefined {
		const resolvedFile = resolvePath(sessionFile);
		if (this.persist) {
			reserveSessionWrite(resolvedFile);
			this.writeFence.opened(resolvedFile);
		}
		const recoveryCause = this.sessionFile === resolvedFile && this.tailMayBeTorn ? this.tornTailCause : "unknown";
		this.tailMayBeTorn = false;
		this.tornTailCause = "unknown";
		this.sessionFile = resolvedFile;
		this.transcriptFile.reset();
		this.mirrorTrimmed = false;
		this.trimmedIds.clear();
		this.residentStore.clear();
		if (existsSync(resolvedFile)) {
			// This process opens the session for append; a final line torn by an interrupted write is set aside now
			// (senpi#4295: every open path, `-c` included), never from read-only loadEntriesFromFile callers.
			if (this.persist) this._settleFinalLine(resolvedFile, recoveryCause);
			return resolvedFile;
		}
		// Same here: the explicit path from --session stays the only granted one.
		// The file does not exist yet, so this open CREATES the session: a caller-supplied
		// id is the session's identity from here on. An EXISTING file never reaches this
		// branch, which is why a supplied id can never overwrite a header id.
		const created = withFileNameId(resolvedFile, newSessionOptions);
		this._resetToNewSession(created);
		// A host-minted id is referenced by nothing yet, so its file may wait for the first
		// assistant message. A CALLER-chosen id (or the id the file name carries) is already held in the caller's own records:
		// the file has to answer to it now, or a reopen before the first reply would mint a
		// different identity and the caller's record would point at nothing (#2010).
		if (created?.id !== undefined) {
			this._rewriteFile();
			this.flushed = true;
		}
		return undefined;
	}

	/** Takes the loaded entries as this session's history; false when an empty file was initialized instead. */
	private _adoptFileEntries(
		sessionFile: string,
		entries: FileEntry[],
		newSessionOptions?: NewSessionOptions,
	): boolean {
		// If file was empty, initialize it with a valid session header. If it was
		// non-empty but did not parse as a pi session, fail without modifying it.
		if (entries.length === 0) {
			if (statSync(sessionFile).size > 0) {
				throw new Error(`Session file is not a valid ${APP_NAME} session: ${sessionFile}`);
			}
			// The explicit path is already granted above and keeps being written here:
			// allocating a second path would take a grant no writer ever uses.
			// An empty file carries no identity yet, so a caller-supplied id still applies.
			this._resetToNewSession(withFileNameId(sessionFile, newSessionOptions));
			this._rewriteFile();
			this.flushed = true;
			return false;
		}

		// A file-backed load keeps the reader contract: an entry set without a header
		// adopts a fresh id in memory instead of creating a replacement session file
		// (which `_loadEntries`' header-less branch would do for ingested entries).
		this.fileEntries = entries;

		const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		this.sessionId = header?.id ?? createSessionId();
		// Blobs left under this id by a process that is gone are a disposable cache:
		// the JSONL is the authority for every entry and this store rewrites what it
		// evicts, so clearing them bounds the directory to one process lifetime.
		this._releaseBlobsDirUnlessShared();

		if (migrateToCurrentVersion(this.fileEntries) && this.writeGuard.isWritable(this.fileEntries)) {
			this._rewriteFile();
		}
		return true;
	}

	/** Indexes the externalized entries; the file is the session's flushed authority from here on. */
	private _completeFileLoad(loadedHistory: SessionEntry[] | undefined): void {
		this._buildIndex();
		this.historyGeneration++;
		// The entries this load already parsed answer the open-time history readers; the view goes when
		// the session settles idle, like any full-history view of a trimmed mirror.
		if (loadedHistory !== undefined) {
			this.historyView = { source: this.fileEntries, length: this.fileEntries.length, entries: loadedHistory };
		}
		this.mutationCount++;
		this.flushed = true;
		this.ownedHeaderFile = undefined;
	}

	newSession(options?: NewSessionOptions): string | undefined {
		const timestamp = this._resetToNewSession(options);
		this.ownedHeaderFile = undefined;
		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			const path = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
			reserveSessionWrite(path);
			this.sessionFile = path;
		}
		this._journalReplace();
		return this.sessionFile;
	}

	/** Resets every in-memory field onto a fresh header. Allocates no session path. */
	private _resetToNewSession(options?: NewSessionOptions): string {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		// Capture the previous backing before the id changes: the blobsDir
		// provider resolves against the new id after this assignment, so clear()
		// below would otherwise leak the old session's blob directory on disk.
		const previousBlobsDir = this.residentStore.resolvedBlobsDir();
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
			...(options?.spawnedBy ? { spawnedBy: options.spawnedBy } : {}),
		};
		this.fileEntries = [header];
		this.transcriptFile.reset();
		this.transcriptBytes = new WeakMap();
		this.historyGeneration++;
		this.verbatimFromCount = 0;
		this.mirrorTrimmed = false;
		this.trimmedIds.clear();
		this.fullEntryCount = 0;
		this.residentStore.clear();
		if (previousBlobsDir) {
			this._removeBlobsDir(previousBlobsDir);
		}
		this.byId.clear();
		this.entryOrdersById.clear();
		this.messageEntryPositions = new WeakMap();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.sessionNameCache = undefined;
		this.usageTotals = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			latestCacheHitRate: undefined,
		};
		this.mutationCount++;
		this.flushed = false;
		return timestamp;
	}

	private _loadEntries(entries: FileEntry[], options?: NewSessionOptions): void {
		const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;

		if (header) {
			this.fileEntries = entries;
			this.sessionId = header.id;

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}
		} else {
			this.newSession(options);
			this.fileEntries = this.fileEntries.concat(entries);
		}

		// Ingested entries join the same resident-string store as file-loaded ones, so large
		// payloads stay out-of-line and every reader materializes through the one path.
		this.fileEntries = this.fileEntries.map((entry) => this.residentStore.externalize(entry));
		this._buildIndex();
		this.historyGeneration++;
		this.mutationCount++;
	}

	/**
	 * Keeps only the latest compaction's window of a just-loaded file resident (senpi#3519). The
	 * full-history count and usage totals are taken from the whole file first: a trimmed mirror
	 * cannot recompute them, so `_buildIndex` leaves them alone while the mirror is trimmed. Returns the
	 * file's full history when it trimmed, undefined when the whole file stays resident.
	 */
	private _retainLoadedTail(): SessionEntry[] | undefined {
		if (!this.persist || this.loadingFullMirror) return undefined;
		const tail = planLoadedTail(this.fileEntries);
		if (tail === undefined) return undefined;
		const history = this.fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
		this.usageTotals = emptyUsageTotals();
		this.fullEntryCount = history.length;
		for (const entry of history) this._accumulateUsage(entry);
		for (const id of tail.trimmedIds) this.trimmedIds.add(id);
		this.mirrorTrimmed = true;
		this.fileEntries = tail.retained;
		this.verbatimFromCount = history.length - tail.windowLength;
		return history;
	}

	private _buildIndex(): void {
		if (!this.mirrorTrimmed) this.verbatimFromCount = 0;
		this.byId.clear();
		this.entryOrdersById.clear();
		this.messageEntryPositions = new WeakMap();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.sessionNameCache = undefined;
		// A trimmed mirror cannot replace the full-history totals, like the count below.
		if (!this.mirrorTrimmed) this.usageTotals = emptyUsageTotals();
		let fullEntryCount = 0;
		for (const [order, entry] of this.fileEntries.entries()) {
			if (entry.type === "session") continue;
			fullEntryCount++;
			this.byId.set(entry.id, entry);
			this.entryOrdersById.set(entry.id, order);
			this.leafId = entry.id;
			if (!this.mirrorTrimmed) this._accumulateUsage(entry);
			if (entry.type === "session_info") {
				// Empty names explicitly clear the session title.
				this.sessionNameCache = entry.name?.trim() || undefined;
			}
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
		// A trimmed mirror cannot replace the full-history count.
		if (!this.mirrorTrimmed) {
			this.fullEntryCount = fullEntryCount;
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		this.writeGuard.assertRewritable(this.fileEntries, this.sessionFile);
		this.writeFence.assertOwned(this.sessionFile);
		reserveSessionWrite(this.sessionFile);
		replaceFileAtomically(
			this.sessionFile,
			this._serializedFileEntries(),
			this.capturesTranscriptBase ? (identity) => this._captureTranscriptBase(identity, this.fileEntries) : undefined,
		);
	}

	/** Wire the owning reader/writer's capture; until it lands snapshots use the bounded accepted tail. */
	private _captureTranscriptBase(
		identity: Promise<FileIdentity | undefined> | undefined,
		entries?: readonly FileEntry[],
	): void {
		if (!identity) return;
		this.transcriptFile.capture(identity, entries, () => {
			const persistence = this._transcriptPersistence();
			if (persistence) {
				this.transcriptJournal?.record({ kind: "persisted", persistence });
				if (entries) this._journalReplace();
			} else if (this.transcriptFile.unavailable)
				this.transcriptJournal?.record({ kind: "unavailable", reason: this.transcriptFile.unavailable });
			this.transcriptBytes = new WeakMap();
		});
	}

	/** Starts journaling committed transcript changes and returns the whole transcript they follow (R3.C1.1). */
	beginTranscriptJournal(): TranscriptTransition[] {
		this.transcriptJournal = new TranscriptJournal();
		return this._transcriptSnapshot();
	}

	/** The transcript changes committed since the journal began or was last drained. */
	drainTranscript(): TranscriptTransition[] {
		return this.transcriptJournal?.drain() ?? [];
	}

	private _journalReplace(): void {
		this.transcriptJournal?.record(...this._transcriptSnapshot());
	}

	private _transcriptSnapshot(): TranscriptTransition[] {
		const { base, history, unavailable } = this.transcriptFile;
		if (unavailable) return [{ kind: "unavailable", reason: unavailable }];
		const unpersisted = base ? this.fullEntryCount - history : this.fileEntries.length;
		const resident = base ? this.fileEntries.length - 1 : this.mirrorTrimmed ? -1 : this.fileEntries.length;
		return snapshotTranscript({
			base,
			unpersisted: unpersisted <= resident ? this.fileEntries.slice(this.fileEntries.length - unpersisted) : undefined,
			leafId: this.leafId,
			own: (entry) => this._transcriptEntryBytes(entry),
			persistence: this._transcriptPersistence(),
		});
	}

	private _transcriptPersistence(): TranscriptPersistence | undefined {
		if (!this.flushed || !this.transcriptFile.identity) return undefined;
		return {
			fileIdentity: this.transcriptFile.identity,
			count: this.fullEntryCount + 1,
		};
	}

	/** Pending journal values are the writer's bytes too, not a second serialization of the same entry. */
	private _transcriptEntryBytes(entry: FileEntry): string {
		const cached = this.transcriptBytes.get(entry);
		if (cached !== undefined) return cached;
		const bytes = JSON.stringify(this.residentStore.materialize(entry));
		if (
			this.persist &&
			this.capturesTranscriptBase &&
			!this.transcriptFile.unavailable &&
			(!this.flushed || !this.transcriptFile.identity)
		)
			this.transcriptBytes.set(entry, bytes);
		return bytes;
	}

	private *_serializedFileEntries(): Generator<string> {
		for (const entry of this.fileEntries) {
			const bytes = this._transcriptEntryBytes(entry);
			if (this.capturesTranscriptBase && !this.transcriptFile.unavailable) this.transcriptBytes.set(entry, bytes);
			yield `${bytes}\n`;
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/**
	 * Exposes the resident store for out-of-band string lifecycles such as the
	 * agent's runtime message state (tokenized while idle, hydrated per turn).
	 */
	getResidentStore(): ResidentStringStore {
		return this.residentStore;
	}

	getResidentStoreStats(): ResidentStoreStats {
		return this.residentStore.stats();
	}

	/**
	 * Writes the buffered header (and anything buffered behind it) through an exclusive create, as
	 * the first assistant message would, and appends every later entry immediately. A session that
	 * is exposed to other processes needs its id on disk first: a reopen of a missing file mints a
	 * new id. The write is asynchronous (the session path never blocks on the filesystem); entries
	 * persisted while it runs are appended by it before the transcript counts as flushed.
	 */
	persistHeaderNow(): Promise<void> {
		if (!this.persist || !this.sessionFile || this.flushed) return this.headerWrite ?? this.transcriptFile.ready;
		const sessionFile = this.sessionFile;
		this.headerWrite ??= this._writeHeaderAsync(sessionFile).finally(() => {
			this.headerWrite = undefined;
		});
		return this.headerWrite;
	}

	isTranscriptFlushed(): boolean {
		return this.flushed;
	}

	/**
	 * Removes the session file when this process created it with persistHeaderNow() and it holds only
	 * setup entries (header, model, thinking level, configuration, labels), `custom` entries their
	 * writer marked `startupBookkeeping` (the startup rules scan, repository identity) and engine lifecycle
	 * bookkeeping (senpi#3864, including a file that bookkeeping created itself), then returns to
	 * buffering so a later entry cannot recreate a header-less file; those entries reach disk again with
	 * the first message (senpi#3263). Any message (user, assistant, `!cmd`), delivered `custom_message`,
	 * session name, other `custom` entry (such as a paid cache prewarm or a todo list) or usage record
	 * keeps the file, and a file opened from disk is never deleted here.
	 */
	async discardHeaderOnlyFile(): Promise<boolean> {
		await this.headerWrite;
		if (!this.persist || !this.sessionFile || !this.flushed) return false;
		if (this.ownedHeaderFile !== this.sessionFile) return false;
		if (!this.fileEntries.every(isDisposableEntry)) return false;
		await rm(this.sessionFile, { force: true });
		this.ownedHeaderFile = undefined;
		this.flushed = false;
		this.transcriptFile.reset();
		return true;
	}

	private async _writeHeaderAsync(sessionFile: string): Promise<void> {
		this.writeFence.assertOwned(sessionFile);
		reserveSessionWrite(sessionFile);
		const entries = this.fileEntries;
		const serialize = (batch: readonly FileEntry[]): string =>
			batch.map((e) => `${this._transcriptEntryBytes(e)}\n`).join("");
		let written = 0;
		let handle: FileHandle | undefined = await open(sessionFile, "wx");
		try {
			while (written < entries.length) {
				const batch = entries.slice(written);
				written += batch.length;
				await handle.writeFile(serialize(batch));
			}
			const closing = handle;
			if (this.capturesTranscriptBase && this.sessionFile === sessionFile && this.fileEntries === entries) {
				this._captureTranscriptBase(captureFileIdentity(closing.fd, sessionFile));
				await this.transcriptFile.ready;
			}
			handle = undefined;
			await closing.close();
			// Entries persisted while the handle closed: append until a pass finds nothing new.
			while (written < entries.length && this.sessionFile === sessionFile && this.fileEntries === entries) {
				const batch = entries.slice(written);
				written += batch.length;
				await appendFile(sessionFile, serialize(batch));
			}
		} catch (error) {
			// This write created the file: a part-written one would fail every later first flush with
			// EEXIST while the entries it was carrying stayed in memory only. Nothing counts as flushed yet.
			return discardFailedFirstFlushAsync(sessionFile, handle, error);
		}
		// Synchronous with the last check above: no entry can land between it and the flag.
		if (this.sessionFile === sessionFile && this.fileEntries === entries && written === entries.length) {
			this.flushed = true;
			this.ownedHeaderFile = sessionFile;
			this.transcriptBytes = new WeakMap();
			const persistence = this.transcriptJournal && this._transcriptPersistence();
			if (persistence) this.transcriptJournal?.record({ kind: "persisted", persistence });
		}
	}

	/**
	 * A new session file is created only once the session contains a user or assistant message.
	 * Setup entries alone (model, thinking level, system prompt) stay in memory so opening and
	 * closing the agent without chatting leaves no file behind. Starting at the user message (not the
	 * first assistant reply) keeps the prompt on disk if the first turn never completes (#10000).
	 * An explicit persistHeaderNow() still writes the header first: a session exposed to other
	 * processes needs its id on disk before any conversation.
	 */
	private _hasConversation(): boolean {
		return this.fileEntries.some(isConversationEntry);
	}

	/**
	 * Receives each repair of this session's file once (senpi#4295): a torn tail set aside on open, or the fragment of a
	 * failed append set aside before the next one. Repairs made before a listener exists are delivered on registration.
	 */
	onRecovery(listener: (recovery: SessionRecovery) => void): () => void {
		this.recoveryListener = listener;
		for (const recovery of this.pendingRecoveries.splice(0)) listener(recovery);
		return () => {
			if (this.recoveryListener === listener) this.recoveryListener = undefined;
		};
	}

	private _reportRecovery(recovery: SessionRecovery): void {
		if (this.recoveryListener === undefined) this.pendingRecoveries.push(recovery);
		else this.recoveryListener(recovery);
	}

	private _settleFinalLine(sessionFile: string, cause: SessionRecoveryCause): void {
		const repair = terminateFinalSessionLine(sessionFile, cause);
		if (repair?.kind === "set_aside") this._reportRecovery(repair.recovery);
		if (repair?.kind === "deferred") {
			this.tailMayBeTorn = true;
			this.tornTailCause = cause;
		}
	}

	/**
	 * Writes `entry`, which is not in `fileEntries` yet, before memory commits it. A throw means the
	 * file did not take the entry, so the caller commits nothing and no later entry can chain onto it.
	 */
	_persist(entry: SessionEntry): string | undefined {
		if (!this.persist || !this.sessionFile) return;
		this.writeGuard.assertWritable(this.fileEntries, entry, this.sessionFile);
		this.writeFence.assertOwned(this.sessionFile);
		reserveSessionWrite(this.sessionFile);

		if (this.flushed) {
			if (this.tailMayBeTorn) {
				const recovery = truncateToLastCompleteLine(this.sessionFile, this.tornTailCause);
				this.tailMayBeTorn = false;
				if (recovery !== undefined) this._reportRecovery(recovery);
			}
			const bytes = this._transcriptEntryBytes(entry);
			try {
				appendFileSync(this.sessionFile, `${bytes}\n`);
			} catch (error) {
				this.tailMayBeTorn = true;
				this.tornTailCause = sessionRecoveryCause(error);
				throw error;
			}
			return bytes;
		}

		// Entries stay in memory only until the branch holds a user or assistant message; then all are
		// written (#10000: the prompt reaches disk even if the first turn never completes).
		const durableLifecycle = entry.type === "custom" && LIFECYCLE_ENTRY_TYPES.has(entry.customType);
		if (!isConversationEntry(entry) && !durableLifecycle && !this._hasConversation()) return;

		// An asynchronous header write owns the file until it finishes, and appends this entry.
		if (this.headerWrite) {
			if (durableLifecycle) throw new Error("Lifecycle append requires the pending session header write to finish");
			return;
		}
		const fd = openSync(this.sessionFile, "wx");
		let bytes: string | undefined;
		try {
			for (const e of [...this.fileEntries, entry]) {
				const serialized = this._transcriptEntryBytes(e);
				writeFileSync(fd, `${serialized}\n`);
				if (e === entry) bytes = serialized;
			}
		} catch (error) {
			discardFailedFirstFlush(this.sessionFile, fd, error);
		}
		if (this.capturesTranscriptBase) this._captureTranscriptBase(captureAndCloseFileIdentity(fd, this.sessionFile));
		else closeSync(fd);
		this.flushed = true;
		if (!this.capturesTranscriptBase) this.transcriptBytes = new WeakMap();
		// Lifecycle bookkeeping created this file before any conversation, so an empty session can still discard it.
		if (!isConversationEntry(entry) && !this._hasConversation()) this.ownedHeaderFile = this.sessionFile;
		return bytes;
	}

	private _appendEntry(
		entry: SessionEntry,
		shareable?: object,
		recoveryOwner?: RecoveryCarrier,
		flow?: () => TranscriptFlow | undefined,
	): void {
		const residentEntry = this.residentStore.externalize(entry);
		const bytes = this._persist(residentEntry);
		const committed = this._shareMessage(residentEntry, shareable);
		this._commitEntry(committed);
		if (this.transcriptJournal) {
			const serialized = bytes ?? this._transcriptEntryBytes(residentEntry);
			if (this.persist && !this.transcriptFile.unavailable && (!this.flushed || !this.transcriptFile.identity))
				this.transcriptBytes.set(committed, serialized);
			const change = flow?.();
			this.transcriptJournal.record({
				kind: "append",
				id: residentEntry.id,
				entry: serialized,
				persistence: this._transcriptPersistence(),
				...(recoveryOwner ? { owningMessageId: recoveryOwner.messageId, recoveryEpoch: recoveryOwner.epoch } : {}),
				...(change ? { flow: change } : {}),
			});
		}
	}

	/**
	 * senpi#2537: the mirror used to hold its own JSON copy of every message the agent persisted, so each
	 * message's object and array skeleton was resident twice (strings were already shared). For a message
	 * that is plain JSON with no resident token, the mirror keeps a shallow copy instead: its own object
	 * (context projections tag it, never the agent's object), sharing the agent's content arrays. The file
	 * holds what `_persist` wrote, and a reload reads the same JSON. Anything else keeps the JSON copy: a
	 * resident token means the idle release may tokenize the agent's strings in place later, and a
	 * non-JSON value (a Date, NaN, a class instance) would make the mirror differ from a reload.
	 */
	private _shareMessage(residentEntry: SessionEntry, shareable: object | undefined): SessionEntry {
		if (shareable === undefined || residentEntry.type !== "message") return residentEntry;
		if (!this.residentStore.isTokenFree(residentEntry)) return residentEntry;
		if (!isPlainJson(shareable)) return residentEntry;
		const shared = { ...residentEntry, message: { ...shareable } as SessionMessageEntry["message"] };
		this.residentStore.adoptTokenFree(shared);
		return shared;
	}

	private _commitEntry(residentEntry: SessionEntry): void {
		this.fileEntries.push(residentEntry);
		this.byId.set(residentEntry.id, residentEntry);
		this.entryOrdersById.set(residentEntry.id, this.fileEntries.length - 1);
		this.leafId = residentEntry.id;
		this.fullEntryCount++;
		this._accumulateUsage(residentEntry);
		this.mutationCount++;
	}

	/**
	 * Append an already-materialized entry without rewriting its identity or tree
	 * fields. This is the transport seam for entries captured by another manager.
	 */
	appendEntry(entry: SessionEntry): void {
		this._appendEntry(entry);
		const order = this.entryOrdersById.get(entry.id);
		if (entry.type === "message" && order !== undefined) {
			this.messageEntryPositions.set(entry.message, { entryId: entry.id, order });
		}
		if (entry.type === "session_info") this.sessionNameCache = entry.name?.trim() || undefined;
		if (entry.type === "label") {
			if (entry.label) {
				this.labelsById.set(entry.targetId, entry.label);
				this.labelTimestampsById.set(entry.targetId, entry.timestamp);
			} else {
				this.labelsById.delete(entry.targetId);
				this.labelTimestampsById.delete(entry.targetId);
			}
		}
	}

	private _materializeEntry(entry: SessionEntry): SessionEntry {
		let missingResidentString = false;
		const materialized = this.residentStore.materialize(entry, () => {
			missingResidentString = true;
			return undefined;
		});
		// The resident store is a bounded cache. The JSONL remains authoritative
		// when an evicted blob is needed by a branch or read operation.
		if (missingResidentString && this.sessionFile) {
			const persisted = loadEntriesFromFile(this.sessionFile).find((candidate) => candidate.id === entry.id);
			if (persisted) return persisted as SessionEntry;
		}
		if (materialized.type === "message") {
			const order = this.entryOrdersById.get(materialized.id);
			if (order !== undefined) {
				this.messageEntryPositions.set(materialized.message, { entryId: materialized.id, order });
			}
		}
		return materialized;
	}

	/**
	 * Fold one entry into the running usage totals. Totals iterate ALL entries
	 * (not branch-scoped), matching the footer hot path's historical semantics.
	 */
	private _accumulateUsage(entry: SessionEntry): void {
		if (entry.type !== "message" || entry.message.role !== "assistant") return;
		const usage = entry.message.usage;
		// Assistant messages persisted without usage (e.g. aborted/error turns in
		// older session files) contribute nothing to the running totals.
		if (!usage) return;
		this.usageTotals.input += usage.input;
		this.usageTotals.output += usage.output;
		this.usageTotals.cacheRead += usage.cacheRead;
		this.usageTotals.cacheWrite += usage.cacheWrite;
		this.usageTotals.cost += usage.cost?.total ?? 0;
		if (usage.costUnknown) this.usageTotals.costUnknown = true;
		const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		this.usageTotals.latestCacheHitRate =
			latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
	}

	/**
	 * O(1) running usage totals across ALL session entries (not branch-scoped).
	 * Maintained incrementally; identical to summing usage over getEntries().
	 */
	getUsageTotals(): UsageTotals {
		return this.usageTotals;
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		return this._appendMessage(message, false);
	}

	/**
	 * `appendMessage` for a message the session's own agent produced and whose content it does not change
	 * after it is persisted (senpi#2537). The mirror keeps a shallow copy that shares the message's content
	 * instead of a full JSON copy (see `_shareMessage` for when it falls back). `appendMessage` keeps the
	 * full copy: a caller may still change its object after appending.
	 */
	appendOwnedMessage(
		message: Message | CustomMessage | BashExecutionMessage,
		options?: { readonly inputSource?: InputSource | undefined; readonly recoveryOwner?: RecoveryCarrier },
	): string {
		return this._appendMessage(message, true, options?.inputSource, options?.recoveryOwner);
	}

	private _appendMessage(
		message: Message | CustomMessage | BashExecutionMessage,
		owned: boolean,
		inputSource?: InputSource,
		recoveryOwner?: RecoveryCarrier,
	): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
			...(inputSource === undefined ? {} : { inputSource }),
		};
		this._appendEntry(entry, owned ? message : undefined, recoveryOwner);
		const order = this.entryOrdersById.get(entry.id);
		if (order !== undefined) {
			this.messageEntryPositions.set(message, { entryId: entry.id, order });
		}
		return entry.id;
	}

	/** Runtime append position for this exact persisted message object, if known. */
	getMessageEntryPosition(message: AgentMessage): Readonly<{ entryId: string; order: number }> | undefined {
		return this.messageEntryPositions.get(message);
	}

	/** Runtime/file append position for an entry, used with getMessageEntryPosition(). */
	getEntryOrder(entryId: string): number | undefined {
		return this.entryOrdersById.get(entryId);
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(
		thinkingLevel: string,
		thinkingSelection?: ThinkingSelection,
		trigger?: ModelChangeOrigin,
		model?: { readonly provider: string; readonly id: string },
	): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
			thinkingSelection,
			...(trigger === undefined ? {} : { triggerSource: trigger.source }),
			...(trigger?.actor === undefined ? {} : { triggerActor: trigger.actor }),
			...(trigger?.effectId === undefined ? {} : { effectId: trigger.effectId }),
			...(model === undefined ? {} : { provider: model.provider, modelId: model.id }),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a durable Responses configuration update as child of current leaf. */
	appendConfigurationUpdate(effort: string): string {
		const entry: ConfigurationUpdateEntry = {
			type: "configuration_update",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			reasoning: { effort },
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Append a refused model switch (#1526). The refusal happens before any
	 * `model_change` is written, so without this the attempt leaves no trace.
	 */
	appendModelChangeRejected(
		details: Omit<ModelChangeRejectedEntry, "type" | "id" | "parentId" | "timestamp">,
	): string {
		const entry: ModelChangeRejectedEntry = {
			type: "model_change_rejected",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...details,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(
		provider: string,
		modelId: string,
		reason?: "fallback" | "fallback-revert",
		originalProvider?: string,
		originalModelId?: string,
		attribution?: { readonly origin: ModelChangeOrigin; readonly duringTurn: boolean },
	): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
			reason,
			originalProvider,
			originalModelId,
			...(attribution === undefined ? {} : { source: attribution.origin.source }),
			...(attribution?.origin.actor === undefined ? {} : { actor: attribution.origin.actor }),
			...(attribution?.duringTurn ? { duringTurn: true } : {}),
			...(attribution?.origin.effectId === undefined ? {} : { effectId: attribution.origin.effectId }),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append model-attributed usage that does not participate in LLM context. Returns the appended entry. */
	appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): UsageEntry {
		const entry: UsageEntry = {
			type: "usage",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			kind,
			provider,
			model,
			usage,
			...(note ? { note } : {}),
		};
		this._appendEntry(entry);
		return entry;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		const timestamp = new Date().toISOString();
		const from = this.buildSessionProjection();
		const systemMessage = getCurrentSystemMessage(from.messages);
		const id = generateId(this.idsInUse);
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id,
			parentId: this.leafId,
			timestamp,
			summary,
			firstKeptEntryId: firstKeptEntryId ?? id,
			tokensBefore,
			details,
			usage,
			fromHook,
			...(systemMessage ? { systemMessage: { ...systemMessage, timestamp: new Date(timestamp).getTime() } } : {}),
		};
		this._appendEntry(entry, undefined, undefined, () =>
			compactionFlow(from.entries, this.buildSessionProjection().entries),
		);
		this._trimMirrorAfterCompaction(entry);
		return entry.id;
	}

	/**
	 * Release what outlives this manager in the process: the shared host's write
	 * grant and the blob directory backing its resident mirror. The session JSONL
	 * is untouched - it is the authority the next reader loads from. Idempotent.
	 */
	dispose(): void {
		this.transcriptFile.reset();
		unregisterSessionWriter(this);
		this._releaseBlobsDirUnlessShared();
	}

	/**
	 * The blob directory is keyed by session id, so every live manager over the same
	 * session file hydrates from it. Removing it while one of them is still reading
	 * would cost that manager a full JSONL recovery per evicted string, so the last
	 * owner to let go is the one that clears it.
	 */
	private _releaseBlobsDirUnlessShared(): void {
		const blobsDir = this.residentStore.resolvedBlobsDir();
		if (!blobsDir) return;
		if (this.sessionFile && hasOtherLiveSessionWriter(this.sessionFile, this)) return;
		this._removeBlobsDir(blobsDir);
	}

	private _removeBlobsDir(dir: string): void {
		try {
			rmSync(dir, { force: true, recursive: true });
		} catch {}
	}

	private _trimMirrorAfterCompaction(compaction: CompactionEntry): void {
		if (!this.persist) return;
		const firstKeptIndex = this.fileEntries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
		const compactionIndex = this.fileEntries.findIndex((entry) => entry.id === compaction.id);
		if (firstKeptIndex < 0 || compactionIndex < firstKeptIndex) return;

		const verbatimStart = this.fileEntries.length - (this.fullEntryCount - this.verbatimFromCount);
		const header = this.fileEntries.find((entry) => entry.type === "session");
		const branchIds = new Set(this.getBranch().map((entry) => entry.id));
		let firstVerbatimIndex = Math.max(firstKeptIndex, verbatimStart);
		for (let i = firstVerbatimIndex; i < compactionIndex; i++) {
			if (!branchIds.has(this.fileEntries[i].id)) firstVerbatimIndex = i + 1;
		}
		this.verbatimFromCount = this.fullEntryCount - (compactionIndex + 1 - firstVerbatimIndex);
		const retained = [
			...this.fileEntries.slice(0, firstKeptIndex).filter((entry) => entry.type !== "message"),
			...this.fileEntries.slice(firstKeptIndex, compactionIndex + 1).filter((entry) => branchIds.has(entry.id)),
		];
		let parentId: string | null = null;
		for (const entry of retained) {
			if (entry.type !== "session") entry.parentId = parentId;
			parentId = entry.type === "session" ? null : entry.id;
		}
		const retainedIds = new Set(retained.map((entry) => entry.id));
		for (const entry of this.fileEntries) {
			if (entry.type !== "session" && !retainedIds.has(entry.id)) this.trimmedIds.add(entry.id);
		}
		this.residentStore.spillResident();
		this.mirrorTrimmed = true;
		this.fileEntries = [header, ...retained]
			.filter((entry): entry is FileEntry => entry !== undefined)
			.map((entry) => this.residentStore.externalize(entry));
		this._buildIndex();
		this.mutationCount++;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. */
	appendCustomEntry(customType: string, data?: unknown, options?: { startupBookkeeping?: boolean }): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			...(options?.startupBookkeeping === true ? { startupBookkeeping: true as const } : {}),
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};
		this._appendEntry(entry);
		this.sessionNameCache = sanitizedName || undefined;
		return entry.id;
	}

	/**
	 * Get the current session name from the latest session_info entry, if any.
	 * O(1): the value is maintained incrementally on appendSessionInfo() and index rebuilds.
	 */
	getSessionName(): string | undefined {
		return this.sessionNameCache;
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		options?: { readonly recoveryOwner?: RecoveryCarrier },
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry, undefined, options?.recoveryOwner);
		return entry.id;
	}

	/** Append a branch-local edit to an earlier model-visible entry. */
	appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): string {
		if (
			replacement !== null &&
			(typeof replacement !== "object" ||
				!("content" in replacement) ||
				(typeof replacement.content !== "string" && !Array.isArray(replacement.content)))
		) {
			throw new Error("Context edit replacement must be null or contain string/array content");
		}
		const target = this.byId.get(targetId);
		if (!target) throw new Error(`Entry ${targetId} not found`);
		if (!this.getBranch().some((entry) => entry.id === targetId)) {
			throw new Error(`Entry ${targetId} is not on the active branch`);
		}
		const editable =
			target.type === "custom_message" ||
			(target.type === "message" &&
				(target.message.role === "user" ||
					target.message.role === "assistant" ||
					target.message.role === "toolResult"));
		if (!editable) throw new Error(`Entry ${targetId} does not contribute editable model content`);
		const targetRole = target.type === "message" ? target.message.role : "custom";
		const normalizedReplacement =
			replacement !== null &&
			(targetRole === "assistant" || targetRole === "toolResult") &&
			typeof replacement.content === "string"
				? { content: [{ type: "text" as const, text: replacement.content }] }
				: replacement;
		const entry: ContextEditEntry = {
			type: "context_edit",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			replacement: normalizedReplacement,
		};
		this._appendEntry(entry, undefined, undefined, () => {
			const edited = this.getEntry(targetId);
			return contextEditFlow(entry, edited && ownedFlowMessage(projectContextEntry(edited, entry)[0]));
		});
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		const entry = this.leafId ? this.byId.get(this.leafId) : undefined;
		return entry ? this._materializeEntry(entry) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		const entry = this.byId.get(id);
		if (entry) return this._materializeEntry(entry);
		if (this.mirrorTrimmed && this.sessionFile) {
			const persisted = this._loadFullHistoryEntries().find((candidate) => candidate.id === id);
			return persisted ? (this.residentStore.materialize(persisted) as SessionEntry) : undefined;
		}
		return undefined;
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(this._materializeEntry(entry));
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		// A target the mirror trimmed is checked against the memoized full history, not a fresh parse of the file.
		if (!this.byId.has(targetId) && !this.getEntries().some((entry) => entry.id === targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.idsInUse),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		// No-arg reads (the common hot path) are memoized on (leafId, mutationCount);
		// explicit fromId lookups bypass the cache.
		if (
			fromId === undefined &&
			this.branchCache !== null &&
			this.branchCache.leafId === this.leafId &&
			this.branchCache.mutation === this.mutationCount
		) {
			return this.branchCache.entries;
		}
		if (fromId === undefined) {
			const extended = this._extendBranchCache();
			if (extended !== undefined) return extended;
		}
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let entriesById = this.byId;
		if (fromId !== undefined && !entriesById.has(fromId) && this.mirrorTrimmed && this.sessionFile) {
			entriesById = new Map(
				this._loadFullHistoryEntries()
					.filter((entry): entry is SessionEntry => entry.type !== "session")
					.map((entry) => [entry.id, this.residentStore.materialize(entry)]),
			);
		}
		let current = startId ? entriesById.get(startId) : undefined;
		const visited = new Set<SessionEntry>();
		while (current && !visited.has(current)) {
			visited.add(current);
			path.push(current);
			current = current.parentId ? entriesById.get(current.parentId) : undefined;
		}
		path.reverse();
		const materializedPath =
			(entriesById === this.byId ? this._fromCompactView(path) : undefined) ?? this._materializeEntries(path);
		if (fromId === undefined) {
			this.branchCache = {
				leafId: this.leafId,
				mutation: this.mutationCount,
				entries: materializedPath,
				source: this.fileEntries,
			};
		}
		return materializedPath;
	}

	/**
	 * The path from `fromId` (default: the leaf) to the root over the whole persisted history. `getBranch()`
	 * answers a trimmed mirror from the latest compaction window (senpi#3519); readers that need every entry
	 * of the path, such as a fork's new file or the files a session touched, read it here from the file.
	 */
	getFullBranch(fromId?: string): SessionEntry[] {
		if (!this.mirrorTrimmed || !this.sessionFile) return this.getBranch(fromId);
		const byId = new Map<string, SessionEntry>();
		for (const entry of this.getEntries()) byId.set(entry.id, entry);
		const path: SessionEntry[] = [];
		const visited = new Set<string>();
		let current = byId.get(fromId ?? this.leafId ?? "");
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			path.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return path.reverse();
	}

	/**
	 * The cached branch extended by entries appended under its leaf since, when that is all that
	 * changed (same mirror array, the new leaf descends from the cached one within a short walk).
	 * Appending a message used to re-materialize the whole branch on the next read.
	 */
	private _extendBranchCache(): SessionEntry[] | undefined {
		const cache = this.branchCache;
		if (cache === null || cache.source !== this.fileEntries || cache.leafId === null) return undefined;
		const added: SessionEntry[] = [];
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		while (current && current.id !== cache.leafId) {
			if (added.length >= 256) return undefined;
			added.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		if (current === undefined) return undefined;
		added.reverse();
		const entries = [...cache.entries, ...(this._fromCompactView(added) ?? this._materializeEntries(added))];
		this.branchCache = { leafId: this.leafId, mutation: this.mutationCount, entries, source: this.fileEntries };
		return entries;
	}

	/**
	 * Build the active, compaction-aware entry list for context/rendering.
	 * Uses tree traversal from current leaf.
	 */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this._getCompactEntries(), this.leafId);
	}

	/**
	 * Build the canonical session projection (context edits, compaction boundary) from the current
	 * leaf. Reads the compact mirror like buildSessionContext(), so a trimmed mirror never reloads
	 * the full history.
	 */
	buildSessionProjection(): SessionProjection {
		const { projection } = this._projectCurrent();
		return { ...projection, messages: [...projection.messages], entries: [...projection.entries] };
	}

	/**
	 * Projection of the current leaf over the compact view, memoized until the view or the leaf
	 * changes: several context builds run per turn over the same, unchanged session. Callers get
	 * copies of the arrays because the agent appends to the message array it receives.
	 */
	private _projectCurrent(): ReturnType<typeof projectSession> {
		const entries = this._getCompactEntries();
		const memo = this.projectionMemo;
		if (memo?.source === entries && memo.leafId === this.leafId) return memo.result;
		const path = this._extendPath(memo, entries) ?? buildSessionPath(entries, this.leafId);
		const result = projectSession(entries, this.leafId, undefined, path);
		this.projectionMemo = { source: entries, leafId: this.leafId, path, result };
		return result;
	}

	/**
	 * The memoized leaf path extended by entries appended under its leaf, when the compact view only
	 * grew by such a chain (the normal case while a session runs); undefined when it must be rebuilt.
	 */
	private _extendPath(memo: SessionManager["projectionMemo"], entries: SessionEntry[]): SessionEntry[] | undefined {
		if (!memo || memo.leafId === null || this.leafId === null) return undefined;
		const previous = memo.source;
		if (entries.length <= previous.length || entries[previous.length - 1] !== previous[previous.length - 1]) {
			return undefined;
		}
		let parentId: string | null = memo.leafId;
		const appended: SessionEntry[] = [];
		for (let index = previous.length; index < entries.length; index++) {
			const entry = entries[index]!;
			if (entry.parentId !== parentId) return undefined;
			appended.push(entry);
			parentId = entry.id;
		}
		if (parentId !== this.leafId) return undefined;
		return [...memo.path, ...appended];
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		const { projection, settings } = this._projectCurrent();
		const { thinkingLevel, thinkingSelection, model, configurationUpdate } = settings;
		return { messages: [...projection.messages], thinkingLevel, thinkingSelection, model, configurationUpdate };
	}

	hasContextMessages(): boolean {
		return this.hasBranchEntry(
			(entry) =>
				entry.type === "message" ||
				entry.type === "custom_message" ||
				entry.type === "compaction" ||
				(entry.type === "branch_summary" && Boolean(entry.summary)),
		);
	}

	hasThinkingLevelChanges(): boolean {
		return this.hasBranchEntry((entry) => entry.type === "thinking_level_change");
	}

	countCompactions(): number {
		let count = 0;
		for (const entry of this.fileEntries) {
			if (entry.type === "compaction") count++;
		}
		return count;
	}

	private hasBranchEntry(predicate: (entry: SessionEntry) => boolean): boolean {
		let current = this.leafId ? this.byId.get(this.leafId) : undefined;
		const visited = new Set<SessionEntry>();
		while (current && !visited.has(current)) {
			if (predicate(current)) return true;
			visited.add(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return false;
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? this.residentStore.materialize(h as SessionHeader) : null;
	}

	/**
	 * Get all session entries (excludes header).
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 *
	 * The result is memoized behind the session mutation counter: repeated calls
	 * without an intervening mutation return the SAME shared array instance.
	 * Callers must not mutate the returned array or its entries; copy first if
	 * you need to filter/reorder.
	 */
	getEntries(): SessionEntry[] {
		if (this.mirrorTrimmed && this.sessionFile) {
			// Every append reaches both the file and the mirror, so the full history is the history
			// read at trim time plus the mirror's tail; per-turn readers no longer re-parse the file.
			const extended = this._extendView(this.historyView);
			if (extended !== undefined) {
				this.historyView = { source: this.fileEntries, length: this.fileEntries.length, entries: extended };
				return extended;
			}
			const history = this._loadFullHistoryEntries()
				.filter((e): e is SessionEntry => e.type !== "session")
				.map((entry) => this.residentStore.materialize(entry));
			this.historyView = { source: this.fileEntries, length: this.fileEntries.length, entries: history };
			return history;
		}
		if (this.entriesCache !== null && this.entriesCache.mutation === this.mutationCount) {
			return this.entriesCache.entries;
		}
		// Not trimmed: every entry is in the mirror, so the compact view is exactly the full list
		// and extends by the appended tail instead of re-copying the session on each mutation.
		const materializedEntries = this._getCompactEntries();
		this.entriesCache = { mutation: this.mutationCount, entries: materializedEntries };
		return materializedEntries;
	}

	/** Returns the maintained non-header entry count without loading or materializing history. */
	getEntryCount(): number {
		return this.fullEntryCount;
	}

	/**
	 * Folds the whole history (every branch, append order, like `getEntries()`) without keeping a full-history view
	 * (senpi#2537): the history is read once per load, later calls fold only the entries appended since. For per-turn
	 * readers that need the latest or the since-last of something; see `HistoryReducer` for the reducer contract.
	 */
	reduceHistory<S>(reducer: HistoryReducer<S>): S {
		return this.historyReductions.reduce(reducer);
	}

	private _appendedSince(count: number): SessionEntry[] | undefined {
		if (count < this.verbatimFromCount) return undefined;
		const wanted = this.fullEntryCount - count;
		const appended: SessionEntry[] = [];
		let missing = false;
		for (let index = this.fileEntries.length - 1; index >= 0 && appended.length < wanted; index--) {
			const entry = this.fileEntries[index]!;
			if (entry.type === "session") break;
			appended.push(
				this.residentStore.materialize(entry, () => {
					missing = true;
					return undefined;
				}),
			);
		}
		return missing || appended.length < wanted ? undefined : appended.reverse();
	}

	private _readWholeHistory(): readonly SessionEntry[] {
		if (!this.mirrorTrimmed || !this.sessionFile) return this._getCompactEntries();
		const held = this._extendView(this.historyView);
		if (held !== undefined) return held;
		return this._loadFullHistoryEntries()
			.filter((entry): entry is SessionEntry => entry.type !== "session")
			.map((entry) => this.residentStore.materialize(entry));
	}

	/**
	 * Release the memoized materialized views. Materialized entries hold the full
	 * persisted strings, so views kept between turns pin the whole session text
	 * in memory even while nothing runs. The next read rebuilds them from the
	 * bounded resident store.
	 */
	dropMaterializedCaches(): void {
		this.entriesCache = null;
		this.branchCache = null;
		this.compactEntriesCache = null;
		this.compactView = null;
		this.historyView = null;
		this.compactLookup = null;
		this.projectionMemo = null;
	}

	/** Whether a full-history view of a trimmed mirror is held: the whole file's entries, parsed. */
	holdsMaterializedHistory(): boolean {
		return this.historyView !== null;
	}

	/** The view's entries extended by the mirror's new tail, or undefined when it must be rebuilt. */
	private _extendView(view: MaterializedView | null): SessionEntry[] | undefined {
		if (view === null || view.source !== this.fileEntries || view.length > this.fileEntries.length) return undefined;
		if (view.length === this.fileEntries.length) return view.entries;
		let missing = false;
		const tail: SessionEntry[] = [];
		for (const entry of this.fileEntries.slice(view.length)) {
			if (entry.type === "session") continue;
			const materialized = this.residentStore.materialize(entry, () => {
				missing = true;
				return undefined;
			}) as SessionEntry;
			tail.push(materialized);
		}
		if (missing) return undefined;
		this._bindMessagePositions(tail);
		return [...view.entries, ...tail];
	}

	/**
	 * The compact view's materialized entry for each path entry, or undefined when one is not in the
	 * view. The branch is a subset of the compact view whenever the leaf is in the mirror; sharing its
	 * objects keeps one materialized copy of the session instead of two (about 20 MB at 50k entries).
	 */
	private _fromCompactView(path: readonly SessionEntry[]): SessionEntry[] | undefined {
		const entries = this._getCompactEntries();
		let lookup = this.compactLookup;
		if (
			lookup === null ||
			lookup.length > entries.length ||
			(lookup.length > 0 && lookup.entries[lookup.length - 1] !== entries[lookup.length - 1])
		) {
			lookup = { entries, length: 0, map: new Map() };
		}
		for (let index = lookup.length; index < entries.length; index++) {
			const entry = entries[index]!;
			lookup.map.set(entry.id, entry);
		}
		this.compactLookup = { entries, length: entries.length, map: lookup.map };
		const shared: SessionEntry[] = [];
		for (const entry of path) {
			const materialized = lookup.map.get(entry.id);
			if (materialized === undefined || materialized.parentId !== entry.parentId) return undefined;
			shared.push(materialized);
		}
		return shared;
	}

	private _bindMessagePositions(entries: readonly SessionEntry[]): void {
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const order = this.entryOrdersById.get(entry.id);
			if (order !== undefined) this.messageEntryPositions.set(entry.message, { entryId: entry.id, order });
		}
	}

	private _materializeEntries(entries: readonly SessionEntry[]): SessionEntry[] {
		return materializeSessionEntries(entries, {
			residentStore: this.residentStore,
			loadHistoryEntries: () => this._loadFullHistoryEntries(),
			onMaterialized: (entry) => {
				if (entry.type !== "message") return;
				const order = this.entryOrdersById.get(entry.id);
				if (order !== undefined) {
					this.messageEntryPositions.set(entry.message, { entryId: entry.id, order });
				}
			},
		});
	}

	private _getCompactEntries(): SessionEntry[] {
		const extended = this._extendView(this.compactView);
		if (extended !== undefined) {
			this.compactView = { source: this.fileEntries, length: this.fileEntries.length, entries: extended };
			return extended;
		}
		if (this.compactEntriesCache?.mutation !== this.mutationCount) {
			this.compactEntriesCache = {
				mutation: this.mutationCount,
				entries: this.fileEntries.filter((e): e is SessionEntry => e.type !== "session"),
			};
		}

		const entries = this.compactEntriesCache.entries;
		const missingEntryIds = new Set<string>();
		for (const entry of entries) {
			this.residentStore.materialize(entry, () => {
				missingEntryIds.add(entry.id);
				return undefined;
			});
		}
		if (missingEntryIds.size > 0 && this.sessionFile) {
			const persistedById = new Map(this._loadFullHistoryEntries().map((entry) => [entry.id, entry]));
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index]!;
				if (!missingEntryIds.has(entry.id)) continue;
				const persisted = persistedById.get(entry.id);
				if (persisted) entries[index] = this.residentStore.externalize(persisted) as SessionEntry;
			}
		}
		const materialized = entries.map((entry) => this.residentStore.materialize(entry) as SessionEntry);
		this._bindMessagePositions(materialized);
		this.compactView = { source: this.fileEntries, length: this.fileEntries.length, entries: materialized };
		return materialized;
	}

	private _loadFullHistoryEntries(): FileEntry[] {
		return this.sessionFile ? sessionEntryLoader(this.sessionFile) : this.fileEntries;
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		// A file with duplicated entry ids (#1247) lists one id more than once. The first occurrence owns
		// the id here (node, label and parent edge); attaching later ones would multiply every subtree.
		for (const entry of entries) {
			if (nodeMap.has(entry.id)) continue;
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (node.entry !== entry) continue;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		this._loadFullMirrorFor(branchFromId);
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const from = this.transcriptJournal && this.buildSessionProjection().entries;
		this.leafId = branchFromId;
		this.mutationCount++;
		this.transcriptJournal?.record({ kind: "leaf", leafId: branchFromId, ...this._branchFlow(from) });
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		const from = this.transcriptJournal && this.buildSessionProjection().entries;
		this.leafId = null;
		this.mutationCount++;
		this.transcriptJournal?.record({ kind: "leaf", leafId: null, ...this._branchFlow(from) });
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null) this._loadFullMirrorFor(branchFromId);
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const fromId = this.leafId ?? "root";
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.idsInUse),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details,
			usage,
			fromHook,
		};
		const from = this.transcriptJournal && this.buildSessionProjection().entries;
		this._appendEntry(entry, undefined, undefined, () => this._branchFlow(from).flow);
		return entry.id;
	}

	/** The messages a leaf move took off and put on the active path, when a consumer journals the transcript. */
	private _branchFlow(from: readonly ProjectedSessionEntry[] | undefined): { flow?: TranscriptFlow } {
		return from ? { flow: branchFlow(from, this.buildSessionProjection().entries) } : {};
	}

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getFullBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}
		this.transcriptFile.reset();
		this.transcriptBytes = new WeakMap();

		// Filter out LabelEntry from path - we'll recreate them from the resolved map.
		// Because labels are real tree entries, later entries can be children of labels;
		// removing labels requires re-chaining the retained path to avoid orphaned subtrees.
		const pathWithoutLabels: SessionEntry[] = [];
		const replacementByLabelId = new Map<string, string>();
		const pendingLabelIds: string[] = [];
		let pathParentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") {
				pendingLabelIds.push(entry.id);
				continue;
			}
			for (const labelId of pendingLabelIds) {
				replacementByLabelId.set(labelId, entry.id);
			}
			pendingLabelIds.length = 0;
			pathWithoutLabels.push(
				entry.type === "compaction"
					? {
							...entry,
							parentId: pathParentId,
							firstKeptEntryId:
								entry.firstKeptEntryId === entry.id
									? entry.id
									: (replacementByLabelId.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId),
						}
					: { ...entry, parentId: pathParentId },
			);
			pathParentId = entry.id;
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// Build label entries
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			reserveSessionWrite(newSessionFile);
			// Materialize the branched entries while the previous backing is still
			// readable, then clear: re-externalizing tokenized entries after clear()
			// would bake sentinel tokens into the new branched JSONL.
			const branchedEntries = this._materializeEntries([...pathWithoutLabels, ...labelEntries]);
			const previousBlobsDir = this.residentStore.resolvedBlobsDir();
			this.residentStore.clear();
			if (previousBlobsDir) {
				this._removeBlobsDir(previousBlobsDir);
			}
			this.mirrorTrimmed = false;
			this.trimmedIds.clear();
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this.fileEntries = [header, ...branchedEntries.map((entry) => this.residentStore.externalize(entry))];
			this._buildIndex();
			this.historyGeneration++;
			this.mutationCount++;

			// Use the same rule as _persist(): write now if the branched path already
			// has a conversation, otherwise let _persist() create the file later.
			if (this._hasConversation()) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}
			this._journalReplace();

			return newSessionFile;
		}

		// In-memory mode: replace current session with the path + labels
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		const branchedEntries = this._materializeEntries([...pathWithoutLabels, ...labelEntries]);
		this.residentStore.clear();
		this.fileEntries = [header, ...branchedEntries.map((entry) => this.residentStore.externalize(entry))];
		this.sessionId = newSessionId;
		this._buildIndex();
		this.historyGeneration++;
		this.mutationCount++;
		this._journalReplace();
		return undefined;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.senpi/agent/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 * @param options Applied only when this open CREATES the session (the path does not exist
	 * yet, or exists and is empty). An existing session file keeps the id in its header.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string, options?: NewSessionOptions): SessionManager {
		const resolvedPath = resolvePath(path);
		reserveSessionWrite(resolvedPath);
		const discovery = discoverOpenHeader(resolvedPath, cwdOverride);
		// The bounded scan is only a discovery optimization. A full load remains
		// authoritative for legacy files with very large headers or prefixes.
		const preloadedFileEntries = discovery.needsFullLoad
			? loadEntriesFromFile(resolvedPath, compactUpdatesEnabled())
			: undefined;
		const header = discovery.header ?? headerOf(preloadedFileEntries);
		const { cwd, dir } = openLocation(resolvedPath, sessionDir, cwdOverride, header);
		return new SessionManager(cwd, dir, resolvedPath, true, options, preloadedFileEntries);
	}

	/**
	 * `open` for a process whose event loop serves other sessions (the multi-session RPC host):
	 * the transcript is parsed and externalized in slices that yield, so opening a large
	 * session never holds every other session's requests (senpi#3518).
	 */
	static async openAsync(
		path: string,
		sessionDir?: string,
		cwdOverride?: string,
		options?: NewSessionOptions,
		slicer: EventLoopSlicer = new EventLoopSlicer(),
	): Promise<SessionManager> {
		const resolvedPath = resolvePath(path);
		reserveSessionWrite(resolvedPath);
		const discovery = discoverOpenHeader(resolvedPath, cwdOverride);
		const preloadedFileEntries = discovery.needsFullLoad
			? await loadEntriesFromFileAsync(resolvedPath, slicer, compactUpdatesEnabled())
			: undefined;
		const header = discovery.header ?? headerOf(preloadedFileEntries);
		const { cwd, dir } = openLocation(resolvedPath, sessionDir, cwdOverride, header);
		const manager = new SessionManager(cwd, dir, resolvedPath, true, options, DEFERRED_FILE_LOAD);
		try {
			await manager._setSessionFileAsync(resolvedPath, preloadedFileEntries, options, slicer);
		} catch (error) {
			manager.dispose();
			throw error;
		}
		return manager;
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.senpi/agent/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** Create an in-memory session (no file persistence), optionally from entries held outside the filesystem. */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options, entries);
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const source = readForkSource(resolvedSourcePath);
		if (source.kind === "empty") {
			throw new Error(`Cannot fork: source session file is empty or has no readable entries: ${resolvedSourcePath}`);
		}
		if (source.kind === "not-a-session") {
			throw new Error(
				`Cannot fork: source file is not a session file (no entry has a session header or a session entry shape): ${resolvedSourcePath}`,
			);
		}
		const sourceEntries = source.entries;

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Create new session file with new ID but forked content
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// Write new header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		reserveSessionWrite(newSessionFile);
		writeFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });

		// Copy all non-header entries from source
		for (const entry of sourceEntries) {
			if (entry.type !== "session") {
				appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
			}
		}

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
	}

	/**
	 * Find an exact session ID without loading transcript bodies.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param id Exact session ID
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
	 */
	static findById(cwd: string, id: string, sessionDir?: string): string | undefined {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const matchesCwd = sessionCwdMatcher(resolvePath(cwd));

		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const path = join(dir, file);
				const header = readSessionHeaderForDiscovery(path);
				if (header?.id !== id) continue;
				if (filterCwd && !matchesCwd(getSessionHeaderCwd(header))) continue;
				return path;
			}
		} catch {
			// Exact session discovery is best-effort, matching list().
		}
		return undefined;
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.senpi/agent/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const matchesCwd = sessionCwdMatcher(resolvePath(cwd));
		const includeSession = (session: SessionInfo) => !filterCwd || matchesCwd(session.cwd);
		const progress: SessionListProgress | undefined = onProgress
			? (loaded, total, partialSessions) => onProgress(loaded, total, partialSessions?.filter(includeSession))
			: undefined;
		const sessions = (await listSessionsFromDir(dir, progress, signal)).filter(includeSession);
		return sortSessionInfos(sessions);
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
	static async listAll(
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgressOrSignal?: SessionListProgress | AbortSignal,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress =
			typeof sessionDirOrOnProgress === "function"
				? sessionDirOrOnProgress
				: typeof onProgressOrSignal === "function"
					? onProgressOrSignal
					: undefined;
		const abortSignal =
			typeof sessionDirOrOnProgress === "string" || typeof onProgressOrSignal === "function"
				? signal
				: (onProgressOrSignal ?? signal);
		abortSignal?.throwIfAborted();
		if (customSessionDir) {
			return sortSessionInfos(await listSessionsFromDir(customSessionDir, progress, abortSignal));
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) return [];
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(sessionsDir, entry.name));

			// Count total files first for accurate progress
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					dirFiles.push([]);
				}
			}

			// Process each directory through its own summary index, with progress over all files
			let loaded = 0;
			const partialSessions: SessionInfo[] = [];
			const onLoaded = (info: SessionInfo | null): void => {
				loaded++;
				if (info) partialSessions.push(info);
				const publish = loaded === 1 || loaded % ALL_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === totalFiles;
				progress?.(loaded, totalFiles, publish ? sortSessionInfos([...partialSessions]) : undefined);
			};
			const sessions: SessionInfo[] = [];
			for (const [index, dir] of dirs.entries()) {
				sessions.push(...(await listSessionFilesInDir(dir, dirFiles[index] ?? [], onLoaded, abortSignal)));
			}

			return sortSessionInfos(sessions);
		} catch {
			abortSignal?.throwIfAborted();
			return [];
		}
	}
}
