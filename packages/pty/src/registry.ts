import { cleanupDetachedChildren, defaultKillProcess, getRuntimePlatform } from "./registry-detached.ts";
import {
	isTerminalSessionExited,
	sessionIdPrefix,
	stopTerminalSession,
	waitForTerminalSessionExit,
} from "./registry-session.ts";
import type {
	MaybePromise,
	SessionRegistryCreateContext,
	SessionRegistryCreateOptions,
	SessionRegistryEntry,
	SessionRegistryOptions,
	SessionRegistrySession,
	SessionRegistrySweepOptions,
	StoredSessionRegistryEntry,
	TerminalSessionSignal,
} from "./registry-types.ts";

export { isTerminalSessionExited, sessionIdPrefix } from "./registry-session.ts";
export type {
	InitialSessionRegistryEntry,
	MaybePromise,
	SessionRegistryCreateContext,
	SessionRegistryCreateOptions,
	SessionRegistryEntry,
	SessionRegistryOptions,
	SessionRegistrySession,
	SessionRegistrySweepOptions,
	TerminalSessionSignal,
	TerminalSessionState,
	TrackedDetachedChild,
} from "./registry-types.ts";
export { SessionRegistryCapacityError } from "./registry-types.ts";

import { SessionRegistryCapacityError } from "./registry-types.ts";

const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_COMMAND = "bash";
const DEFAULT_STOP_EXIT_GRACE_MS = 5000;
const MAX_STOP_EXIT_GRACE_MS = 2_147_483_647;

export class SessionRegistry<TSession extends SessionRegistrySession = SessionRegistrySession> {
	private readonly entries = new Map<string, StoredSessionRegistryEntry<TSession>>();
	private readonly idCounters = new Map<string, number>();
	private readonly createSession: ((options: SessionRegistryCreateContext) => MaybePromise<TSession>) | null;
	private readonly killProcess: (target: number, signal: TerminalSessionSignal) => void;
	private readonly now: () => number;
	private readonly platform: string;
	private sequence = 0;
	readonly maxSessions: number;
	private readonly stopExitGraceMs: number;

	constructor(options: SessionRegistryOptions<TSession> = {}) {
		this.maxSessions = normalizeMaxSessions(options.maxSessions);
		this.stopExitGraceMs =
			options.stopExitGraceMs !== undefined &&
			Number.isFinite(options.stopExitGraceMs) &&
			options.stopExitGraceMs > 0
				? Math.min(options.stopExitGraceMs, MAX_STOP_EXIT_GRACE_MS)
				: DEFAULT_STOP_EXIT_GRACE_MS;
		this.createSession = options.createSession ?? null;
		this.killProcess = options.killProcess ?? defaultKillProcess;
		this.now = options.now ?? Date.now;
		this.platform = options.platform ?? getRuntimePlatform();

		for (const initial of options.initialSessions ?? []) {
			this.addEntry(initial.id, initial.session, initial.command ?? initial.session.command ?? DEFAULT_COMMAND);
		}
		void this.sweepExited();
	}

	get size(): number {
		return this.entries.size;
	}

	list(): readonly SessionRegistryEntry<TSession>[] {
		this.refreshExitedStates();
		return [...this.entries.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	get(id: string): SessionRegistryEntry<TSession> | null {
		const entry = this.entries.get(id);
		if (!entry) return null;
		entry.lastUsedAt = this.timestamp();
		this.refreshEntryState(entry);
		return entry;
	}

	async create(options: SessionRegistryCreateOptions<TSession> = {}): Promise<SessionRegistryEntry<TSession>> {
		await this.enforceCapacityForCreate();
		const command = options.command ?? options.session?.command ?? DEFAULT_COMMAND;
		const id = this.allocateId(command);
		const session =
			options.session ??
			(await this.createSessionWithFactory({
				id,
				command,
				args: options.args,
				cwd: options.cwd,
				env: options.env,
				cols: options.cols,
				rows: options.rows,
			}));
		return this.addEntry(id, session, command);
	}

	async sweepExited(options: SessionRegistrySweepOptions = {}): Promise<readonly string[]> {
		this.refreshExitedStates();
		const sweptIds: string[] = [];
		for (const entry of this.entries.values()) {
			if (entry.state !== "exited") continue;
			await this.cleanupDetachedChildren(entry);
			sweptIds.push(entry.id);
			if (options.remove) this.removeEntry(entry.id);
		}
		return sweptIds;
	}

	async stop(id: string): Promise<boolean> {
		const entry = this.entries.get(id);
		if (!entry) return false;
		if (entry.stopPromise) return entry.stopPromise;
		entry.stopPromise = this.stopEntry(entry);
		return entry.stopPromise;
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
	}

	async teardown(): Promise<void> {
		await this.stopAll();
		for (const id of [...this.entries.keys()]) this.removeEntry(id);
	}

	private async createSessionWithFactory(options: SessionRegistryCreateContext): Promise<TSession> {
		if (!this.createSession) {
			throw new Error("Cannot create terminal session: SessionRegistry requires a createSession factory.");
		}
		return this.createSession(options);
	}

	private addEntry(id: string, session: TSession, command: string): SessionRegistryEntry<TSession> {
		const timestamp = this.timestamp();
		const exited = isTerminalSessionExited(session);
		const entry: StoredSessionRegistryEntry<TSession> = {
			id,
			command,
			session,
			createdAt: timestamp,
			lastUsedAt: timestamp,
			state: exited ? "exited" : "live",
			exitedAt: exited ? timestamp : null,
			unsubscribeExit: null,
			stopPromise: null,
			detachedCleanupPromise: null,
		};
		entry.unsubscribeExit =
			session.onExit?.(() => {
				void this.handleSessionExit(id);
			}) ?? null;
		this.entries.set(id, entry);
		this.observeId(id);
		return entry;
	}

	private async handleSessionExit(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.markExited(entry);
		await this.cleanupDetachedChildren(entry);
	}

	private async enforceCapacityForCreate(): Promise<void> {
		this.refreshExitedStates();
		await this.pruneExitedUntilAtMost(this.maxSessions - 1);
		if (this.entries.size >= this.maxSessions) throw new SessionRegistryCapacityError(this.maxSessions);
	}

	private async pruneExitedUntilAtMost(maxSize: number): Promise<void> {
		while (this.entries.size > maxSize) {
			const entry = this.findLeastRecentlyUsedExited();
			if (!entry) return;
			await this.cleanupDetachedChildren(entry);
			this.removeEntry(entry.id);
		}
	}

	private findLeastRecentlyUsedExited(): StoredSessionRegistryEntry<TSession> | null {
		let selected: StoredSessionRegistryEntry<TSession> | null = null;
		for (const entry of this.entries.values()) {
			if (entry.state !== "exited") continue;
			if (!selected || entry.lastUsedAt < selected.lastUsedAt) selected = entry;
			else if (selected.lastUsedAt === entry.lastUsedAt && entry.createdAt < selected.createdAt) selected = entry;
		}
		return selected;
	}

	private async stopEntry(entry: StoredSessionRegistryEntry<TSession>): Promise<boolean> {
		this.refreshEntryState(entry);
		await this.cleanupDetachedChildren(entry);
		if (entry.state !== "exited") {
			await stopTerminalSession(entry.session);
			if (await waitForTerminalSessionExit(entry.session, this.stopExitGraceMs)) {
				this.markExited(entry);
			} else {
				entry.state = "stopping";
				entry.exitedAt = null;
			}
		}
		return true;
	}

	private async cleanupDetachedChildren(entry: StoredSessionRegistryEntry<TSession>): Promise<void> {
		if (entry.detachedCleanupPromise) return entry.detachedCleanupPromise;
		entry.detachedCleanupPromise = this.cleanupDetachedChildrenOnce(entry.session);
		return entry.detachedCleanupPromise;
	}

	private async cleanupDetachedChildrenOnce(session: TSession): Promise<void> {
		await cleanupDetachedChildren(session, this.platform, this.killProcess);
	}

	private refreshExitedStates(): void {
		for (const entry of this.entries.values()) this.refreshEntryState(entry);
	}

	private refreshEntryState(entry: StoredSessionRegistryEntry<TSession>): void {
		if (entry.state === "exited") return;
		if (isTerminalSessionExited(entry.session)) this.markExited(entry);
	}

	private markExited(entry: StoredSessionRegistryEntry<TSession>): void {
		if (entry.state === "exited") return;
		entry.state = "exited";
		entry.exitedAt = this.timestamp();
	}

	private removeEntry(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.unsubscribeExit?.();
		this.entries.delete(id);
	}

	private allocateId(command: string): string {
		const prefix = sessionIdPrefix(command);
		let next = (this.idCounters.get(prefix) ?? 0) + 1;
		while (this.entries.has(`${prefix}_${next}`)) next += 1;
		this.idCounters.set(prefix, next);
		return `${prefix}_${next}`;
	}

	private observeId(id: string): void {
		const match = /^(.*)_(\d+)$/.exec(id);
		if (!match) return;
		const prefix = match[1];
		const value = Number.parseInt(match[2] ?? "", 10);
		if (!prefix || !Number.isFinite(value)) return;
		this.idCounters.set(prefix, Math.max(this.idCounters.get(prefix) ?? 0, value));
	}

	private timestamp(): number {
		this.sequence += 1;
		return this.now() * 1000 + this.sequence;
	}
}

function normalizeMaxSessions(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_SESSIONS;
	if (!Number.isFinite(value) || value < 1) throw new Error("maxSessions must be a positive finite number.");
	return Math.trunc(value);
}
