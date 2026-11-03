import { randomBytes } from "node:crypto";
import type { Options, SDKUserMessage, SdkQuery, SdkQueryHandle } from "./sdk-boundary.ts";
import { getSdkBoundary } from "./sdk-boundary.ts";
import {
	annotateBranchInfo,
	annotatePendingFork,
	annotateTainted,
	switchEntryModel,
} from "./session-entry-annotations.ts";
import { recordPendingCloseCause } from "./session-observability.ts";
import { SessionReapScheduler, type SessionRegistryReapHandle } from "./session-reaper.ts";
import {
	type AnthropicSubscriptionSessionState,
	transitionToClosed,
	transitionToClosing,
} from "./session-registry-state.ts";

export const SESSION_REGISTRY_IDLE_TTL_MS = 30 * 60_000;
export const SESSION_REGISTRY_MAX_ENTRIES = 32;
/** Idle resident processes one senpi process keeps; in-use entries never count against it (senpi#5689). */
export const SESSION_REGISTRY_MAX_IDLE_ENTRIES = 8;
export const SESSION_REGISTRY_MAX_IDLE_ENV = "SENPI_CLAUDE_SDK_OAUTH_MAX_IDLE_SESSIONS";

export function resolveMaxIdleEntries(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[SESSION_REGISTRY_MAX_IDLE_ENV]?.trim();
	const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : SESSION_REGISTRY_MAX_IDLE_ENTRIES;
}

export interface SessionInputController extends AsyncIterable<SDKUserMessage> {
	push(message: SDKUserMessage): void;
	close(): void;
}

class StreamingInputController implements SessionInputController, AsyncIterator<SDKUserMessage> {
	private closed = false;
	private readonly pending: SDKUserMessage[] = [];
	private readonly readers: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKUserMessage>> {
		const message = this.pending.shift();
		if (message) return Promise.resolve({ value: message, done: false });
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	push(message: SDKUserMessage): void {
		if (this.closed) throw new Error("Cannot push to a closed session input controller");
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.pending.push(message);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}
}

export type SessionRegistryBoundary = {
	now: () => number;
	queryFactory: SdkQuery;
	scheduleReap: (callback: () => void, delayMs: number) => SessionRegistryReapHandle;
	maxIdleEntries: () => number;
};

const defaultSessionRegistryBoundary: SessionRegistryBoundary = {
	now: () => Date.now(),
	queryFactory: (input) => getSdkBoundary().query(input),
	scheduleReap: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return { cancel: () => clearTimeout(timer), unref: () => timer.unref() };
	},
	maxIdleEntries: () => resolveMaxIdleEntries(),
};
let activeSessionRegistryBoundary = defaultSessionRegistryBoundary;

export function overrideSessionRegistryBoundary(override: Partial<SessionRegistryBoundary>): void {
	activeSessionRegistryBoundary = { ...defaultSessionRegistryBoundary, ...override };
}

export function resetSessionRegistryBoundary(): void {
	activeSessionRegistryBoundary = defaultSessionRegistryBoundary;
}

export type { SessionRegistryReapHandle };

export type SessionBranchInfo = { oldLeafId: string; newLeafId: string };

export interface AnthropicSubscriptionSessionEntry {
	senpiSessionId: string;
	sdkSessionId: string;
	sdkSessionIdConfirmed: boolean;
	generation: number;
	accountName: string;
	modelId: string;
	toolsetHash: string;
	systemPromptHash: string;
	query: SdkQueryHandle;
	inputController: SessionInputController;
	pumpTask: Promise<void> | null;
	state: AnthropicSubscriptionSessionState;
	activeTurn: unknown | null;
	syncedPrefixHash: string | null;
	sentCount: number;
	assistantUuidByIndex: Map<number, string>;
	branchInfo: SessionBranchInfo | null;
	taintedReason: string | null;
	/** Wave C seam: a divergence boundary recorded for the next continuity decision. */
	pendingForkReason: string | null;
	/** senpi#1975: first diverged field path the commit boundary named for the pending fork, when it named one. */
	pendingForkDivergedPath: string | null;
	lastUsedAt: number;
	/** Digest of the access token the resident subprocess was spawned with. */
	credentialDigest?: string;
	/**
	 * Close cause once the entry is idle, set when its session's run settled and it should not stay
	 * resident (a finished child, senpi#5689). The entry then has a zero idle TTL instead of 30 minutes.
	 */
	releaseOnIdle?: string;
}

export interface CreateSessionRegistryEntryInput {
	senpiSessionId: string;
	accountName: string;
	modelId: string;
	toolsetHash: string;
	systemPromptHash: string;
	options: Options;
	resume?: { sdkSessionId: string; atUuid?: string };
}

export class SessionRegistryResourceLimitError extends Error {
	readonly code = "session_registry_capacity";

	constructor() {
		super(
			`Anthropic Subscription session registry is at its ${SESSION_REGISTRY_MAX_ENTRIES}-entry limit with no idle session to evict`,
		);
		this.name = "SessionRegistryResourceLimitError";
	}
}

export function createSessionUuid(now = Date.now()): `${string}-${string}-${string}-${string}-${string}` {
	const ts = BigInt(Math.trunc(now));
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
		...Array.from(bytes.slice(4), (byte) => byte.toString(16).padStart(2, "0")),
	].join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function evictable(entry: AnthropicSubscriptionSessionEntry): boolean {
	return (entry.state === "IDLE_SYNCED" || entry.state === "TAINTED") && entry.activeTurn === null;
}

function idleTtlMs(entry: AnthropicSubscriptionSessionEntry): number {
	return entry.releaseOnIdle === undefined ? SESSION_REGISTRY_IDLE_TTL_MS : 0;
}

export class AnthropicSubscriptionSessionRegistry {
	private readonly entries = new Map<string, AnthropicSubscriptionSessionEntry>();
	/**
	 * Monotonic per-registry generation counter. Numbers are never reused for
	 * a session id, so stale async work gated on `isCurrentGeneration` cannot be
	 * mistaken for current after a close/reopen cycle. A per-id map of last-used
	 * numbers would grow once per distinct session id for process lifetime;
	 * this counter provides the same (stronger, process-wide) uniqueness with no
	 * residue at all.
	 */
	private generationCounter = 0;
	private readonly reaper = new SessionReapScheduler({
		now: () => activeSessionRegistryBoundary.now(),
		scheduleTimer: (callback, delayMs) => activeSessionRegistryBoundary.scheduleReap(callback, delayMs),
		idleTtlMs: SESSION_REGISTRY_IDLE_TTL_MS,
		candidate: (senpiSessionId, generation) => {
			const entry = this.entries.get(senpiSessionId);
			if (!entry || entry.generation !== generation || !evictable(entry)) return undefined;
			return { generation: entry.generation, lastUsedAt: entry.lastUsedAt, idleTtlMs: idleTtlMs(entry) };
		},
		expire: (senpiSessionId) =>
			this.closeSession(senpiSessionId, this.entries.get(senpiSessionId)?.releaseOnIdle ?? "idle_ttl"),
	});

	get size(): number {
		return this.entries.size;
	}

	get(senpiSessionId: string): AnthropicSubscriptionSessionEntry | undefined {
		return this.entries.get(senpiSessionId);
	}

	getOrCreate(input: CreateSessionRegistryEntryInput): AnthropicSubscriptionSessionEntry {
		const existing = this.entries.get(input.senpiSessionId);
		if (existing) {
			const now = activeSessionRegistryBoundary.now();
			if (!evictable(existing) || now - existing.lastUsedAt < SESSION_REGISTRY_IDLE_TTL_MS) {
				// A new turn before a pending release fires keeps the warm process; the run's own settle
				// releases it again.
				existing.releaseOnIdle = undefined;
				this.touch(existing);
				return existing;
			}
			this.closeSession(existing.senpiSessionId, "idle_ttl");
		}
		this.evictExpired();
		this.trimIdle();
		this.ensureCapacity();
		const now = activeSessionRegistryBoundary.now();
		const generation = ++this.generationCounter;
		const sdkSessionId = input.resume?.sdkSessionId ?? createSessionUuid(now);
		const inputController = new StreamingInputController();
		const lineageOptions = input.resume
			? {
					resume: input.resume.sdkSessionId,
					...(input.resume.atUuid ? { resumeSessionAt: input.resume.atUuid, forkSession: true } : {}),
				}
			: { sessionId: sdkSessionId };
		const query = activeSessionRegistryBoundary.queryFactory({
			prompt: inputController,
			options: {
				...input.options,
				...lineageOptions,
				extraArgs: { ...input.options.extraArgs, "replay-user-messages": "" },
			},
		});
		const { resume: _resume, ...entryInput } = input;
		const target: AnthropicSubscriptionSessionEntry = {
			...entryInput,
			sdkSessionId,
			sdkSessionIdConfirmed: input.resume !== undefined,
			generation,
			query,
			inputController,
			pumpTask: null,
			state: "STARTING",
			activeTurn: null,
			syncedPrefixHash: null,
			sentCount: 0,
			assistantUuidByIndex: new Map(),
			branchInfo: null,
			taintedReason: null,
			pendingForkReason: null,
			pendingForkDivergedPath: null,
			lastUsedAt: now,
		};
		// oxlint-disable-next-line eslint/prefer-const -- a closure reads it; const would throw in the TDZ if that closure ran before the assignment, so the rewrite is reviewed separately
		let entry!: AnthropicSubscriptionSessionEntry;
		entry = new Proxy(target, {
			set: (current, property, value) => {
				if (this.entries.get(current.senpiSessionId) !== entry) return true;
				const previousTurn = current.activeTurn;
				Reflect.set(current, property, value);
				if (property === "activeTurn" && previousTurn !== value) {
					this.recordUse(entry, value === null);
				}
				return true;
			},
		});
		this.entries.set(input.senpiSessionId, entry);
		return entry;
	}

	touch(entry: AnthropicSubscriptionSessionEntry): void {
		this.recordUse(entry, entry.activeTurn === null && evictable(entry));
	}

	closeSession(senpiSessionId: string, reason: string): void {
		const entry = this.entries.get(senpiSessionId);
		if (!entry) return;
		recordPendingCloseCause(senpiSessionId, reason);
		this.reaper.cancel(senpiSessionId, entry.generation);
		transitionToClosing(entry);
		entry.inputController.close();
		try {
			entry.query.close();
		} finally {
			transitionToClosed(entry);
			this.reaper.cancel(senpiSessionId, entry.generation);
			this.entries.delete(senpiSessionId);
		}
	}

	/**
	 * Retire the entry's resident process as soon as it is idle: now when it already is, otherwise
	 * through the generation-fenced reaper right after its in-flight turn goes idle. Never cuts a turn.
	 */
	releaseWhenIdle(senpiSessionId: string, reason: string): void {
		const entry = this.entries.get(senpiSessionId);
		if (!entry) return;
		entry.releaseOnIdle = reason;
		if (evictable(entry)) this.closeSession(senpiSessionId, reason);
	}

	isCurrentGeneration(senpiSessionId: string, generation: number): boolean {
		return this.entries.get(senpiSessionId)?.generation === generation;
	}

	evictExpired(): void {
		const now = activeSessionRegistryBoundary.now();
		for (const entry of [...this.entries.values()]) {
			if (evictable(entry) && now - entry.lastUsedAt >= idleTtlMs(entry)) {
				this.closeSession(entry.senpiSessionId, entry.releaseOnIdle ?? "idle_ttl");
			}
		}
	}

	private recordUse(entry: AnthropicSubscriptionSessionEntry, scheduleReap: boolean): void {
		if (this.entries.get(entry.senpiSessionId) !== entry) return;
		entry.lastUsedAt = activeSessionRegistryBoundary.now();
		this.reaper.cancel(entry.senpiSessionId, entry.generation);
		if (!scheduleReap) return;
		this.reaper.arm(entry.senpiSessionId, entry.generation, idleTtlMs(entry));
		this.trimIdle(entry);
	}

	/**
	 * Close least-recently-used idle entries beyond the idle cap; in-use entries are never candidates.
	 * `settling` is the entry whose turn just cleared: the pump moves it to IDLE_SYNCED right after,
	 * so it counts as idle here but is never the victim.
	 */
	private trimIdle(settling?: AnthropicSubscriptionSessionEntry): void {
		const idle = [...this.entries.values()]
			.filter((entry) => entry !== settling && evictable(entry))
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
		const settlingCounts =
			settling !== undefined && (evictable(settling) || settling.state === "TURN_RESULT_SEEN") ? 1 : 0;
		const excess = idle.length + settlingCounts - activeSessionRegistryBoundary.maxIdleEntries();
		for (const entry of idle.slice(0, Math.max(0, excess))) this.closeSession(entry.senpiSessionId, "idle_cap");
	}

	private ensureCapacity(): void {
		if (this.entries.size < SESSION_REGISTRY_MAX_ENTRIES) return;
		const oldest = [...this.entries.values()]
			.filter(evictable)
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
		if (!oldest) throw new SessionRegistryResourceLimitError();
		this.closeSession(oldest.senpiSessionId, "capacity");
	}
}

export const sessionRegistry = new AnthropicSubscriptionSessionRegistry();

export function getOrCreateSession(input: CreateSessionRegistryEntryInput): AnthropicSubscriptionSessionEntry {
	return sessionRegistry.getOrCreate(input);
}

export function getSession(senpiSessionId: string): AnthropicSubscriptionSessionEntry | undefined {
	return sessionRegistry.get(senpiSessionId);
}

export function closeSession(senpiSessionId: string, reason: string): void {
	sessionRegistry.closeSession(senpiSessionId, reason);
}

export function releaseSessionWhenIdle(senpiSessionId: string, reason: string): void {
	sessionRegistry.releaseWhenIdle(senpiSessionId, reason);
}

export function isIdleExpired(entry: Pick<AnthropicSubscriptionSessionEntry, "lastUsedAt">): boolean {
	return activeSessionRegistryBoundary.now() - entry.lastUsedAt >= SESSION_REGISTRY_IDLE_TTL_MS;
}

export function markTainted(senpiSessionId: string, reason: string): void {
	annotateTainted(sessionRegistry, senpiSessionId, reason);
}

export async function switchSessionModel(senpiSessionId: string, modelId: string, sdkModel?: string): Promise<boolean> {
	return switchEntryModel(sessionRegistry, senpiSessionId, modelId, sdkModel);
}

export function recordPendingFork(senpiSessionId: string, reason: string, divergedPath?: string): void {
	annotatePendingFork(sessionRegistry, senpiSessionId, reason, divergedPath);
}

export function recordBranchInfo(senpiSessionId: string, info: SessionBranchInfo): void {
	annotateBranchInfo(sessionRegistry, senpiSessionId, info);
}

export function isCurrentGeneration(senpiSessionId: string, generation: number): boolean {
	return sessionRegistry.isCurrentGeneration(senpiSessionId, generation);
}
