import { randomBytes } from "node:crypto";
import type { AccountSlot } from "./accounts.ts";
import { EXPIRING_WITHIN_MS } from "./auth-lane.ts";
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
import { type ClaudeSdkOauthSessionState, transitionToClosed, transitionToClosing } from "./session-registry-state.ts";

export const SESSION_REGISTRY_IDLE_TTL_MS = 30 * 60_000;
export const SESSION_REGISTRY_MAX_ENTRIES = 32;

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
};

const defaultSessionRegistryBoundary: SessionRegistryBoundary = {
	now: () => Date.now(),
	queryFactory: (input) => getSdkBoundary().query(input),
	scheduleReap: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return { cancel: () => clearTimeout(timer), unref: () => timer.unref() };
	},
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

export interface ClaudeSdkOauthSessionEntry {
	senpiSessionId: string;
	sdkSessionId: string;
	generation: number;
	accountName: string;
	modelId: string;
	toolsetHash: string;
	systemPromptHash: string;
	query: SdkQueryHandle;
	inputController: SessionInputController;
	pumpTask: Promise<void> | null;
	state: ClaudeSdkOauthSessionState;
	activeTurn: unknown | null;
	syncedPrefixHash: string | null;
	sentCount: number;
	assistantUuidByIndex: Map<number, string>;
	branchInfo: SessionBranchInfo | null;
	taintedReason: string | null;
	/** Wave C seam: a divergence boundary recorded for the next continuity decision. */
	pendingForkReason: string | null;
	lastUsedAt: number;
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
			`Claude SDK OAuth session registry is at its ${SESSION_REGISTRY_MAX_ENTRIES}-entry limit with no idle session to evict`,
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

function evictable(entry: ClaudeSdkOauthSessionEntry): boolean {
	return (entry.state === "IDLE_SYNCED" || entry.state === "TAINTED") && entry.activeTurn === null;
}

export class ClaudeSdkOauthSessionRegistry {
	private readonly entries = new Map<string, ClaudeSdkOauthSessionEntry>();
	private readonly generations = new Map<string, number>();
	private readonly reaper = new SessionReapScheduler({
		now: () => activeSessionRegistryBoundary.now(),
		scheduleTimer: (callback, delayMs) => activeSessionRegistryBoundary.scheduleReap(callback, delayMs),
		idleTtlMs: SESSION_REGISTRY_IDLE_TTL_MS,
		candidate: (senpiSessionId, generation) => {
			const entry = this.entries.get(senpiSessionId);
			if (!entry || entry.generation !== generation || !evictable(entry)) return undefined;
			return { generation: entry.generation, lastUsedAt: entry.lastUsedAt };
		},
		expire: (senpiSessionId) => this.closeSession(senpiSessionId, "idle_ttl"),
	});

	get size(): number {
		return this.entries.size;
	}

	get(senpiSessionId: string): ClaudeSdkOauthSessionEntry | undefined {
		return this.entries.get(senpiSessionId);
	}

	getOrCreate(input: CreateSessionRegistryEntryInput): ClaudeSdkOauthSessionEntry {
		const existing = this.entries.get(input.senpiSessionId);
		if (existing) {
			const now = activeSessionRegistryBoundary.now();
			if (!evictable(existing) || now - existing.lastUsedAt < SESSION_REGISTRY_IDLE_TTL_MS) {
				this.touch(existing);
				return existing;
			}
			this.closeSession(existing.senpiSessionId, "idle_ttl");
		}
		this.evictExpired();
		this.ensureCapacity();
		const now = activeSessionRegistryBoundary.now();
		const generation = (this.generations.get(input.senpiSessionId) ?? 0) + 1;
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
		const target: ClaudeSdkOauthSessionEntry = {
			...entryInput,
			sdkSessionId,
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
			lastUsedAt: now,
		};
		let entry!: ClaudeSdkOauthSessionEntry;
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
		this.generations.set(input.senpiSessionId, generation);
		this.entries.set(input.senpiSessionId, entry);
		return entry;
	}

	touch(entry: ClaudeSdkOauthSessionEntry): void {
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

	isCurrentGeneration(senpiSessionId: string, generation: number): boolean {
		return this.entries.get(senpiSessionId)?.generation === generation;
	}

	evictExpired(): void {
		const now = activeSessionRegistryBoundary.now();
		for (const entry of [...this.entries.values()]) {
			if (evictable(entry) && now - entry.lastUsedAt >= SESSION_REGISTRY_IDLE_TTL_MS) {
				this.closeSession(entry.senpiSessionId, "idle_ttl");
			}
		}
	}

	private recordUse(entry: ClaudeSdkOauthSessionEntry, scheduleReap: boolean): void {
		if (this.entries.get(entry.senpiSessionId) !== entry) return;
		entry.lastUsedAt = activeSessionRegistryBoundary.now();
		this.reaper.cancel(entry.senpiSessionId, entry.generation);
		if (scheduleReap) this.reaper.arm(entry.senpiSessionId, entry.generation);
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

export const sessionRegistry = new ClaudeSdkOauthSessionRegistry();

export function getOrCreateSession(input: CreateSessionRegistryEntryInput): ClaudeSdkOauthSessionEntry {
	return sessionRegistry.getOrCreate(input);
}

export function getSession(senpiSessionId: string): ClaudeSdkOauthSessionEntry | undefined {
	return sessionRegistry.get(senpiSessionId);
}

export function closeSession(senpiSessionId: string, reason: string): void {
	sessionRegistry.closeSession(senpiSessionId, reason);
}

export function isIdleExpired(entry: Pick<ClaudeSdkOauthSessionEntry, "lastUsedAt">): boolean {
	return activeSessionRegistryBoundary.now() - entry.lastUsedAt >= SESSION_REGISTRY_IDLE_TTL_MS;
}

export function markTainted(senpiSessionId: string, reason: string): void {
	annotateTainted(sessionRegistry, senpiSessionId, reason);
}

export async function switchSessionModel(senpiSessionId: string, modelId: string): Promise<boolean> {
	return switchEntryModel(sessionRegistry, senpiSessionId, modelId);
}

export function recordPendingFork(senpiSessionId: string, reason: string): void {
	annotatePendingFork(sessionRegistry, senpiSessionId, reason);
}

export function recordBranchInfo(senpiSessionId: string, info: SessionBranchInfo): void {
	annotateBranchInfo(sessionRegistry, senpiSessionId, info);
}

export function isCurrentGeneration(senpiSessionId: string, generation: number): boolean {
	return sessionRegistry.isCurrentGeneration(senpiSessionId, generation);
}

export function isBoundAccountTokenExpiring(
	entry: Pick<ClaudeSdkOauthSessionEntry, "accountName">,
	accounts: readonly Pick<AccountSlot, "name" | "expires" | "source">[],
): boolean {
	const account = accounts.find((candidate) => candidate.name === entry.accountName);
	return account?.source !== "env" && account !== undefined
		? activeSessionRegistryBoundary.now() >= account.expires - EXPIRING_WITHIN_MS
		: false;
}
