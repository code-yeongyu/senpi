export type TerminalSessionState = "live" | "stopping" | "exited";
export type TerminalSessionSignal = NodeJS.Signals;
export type MaybePromise<T> = T | Promise<T>;

export interface TrackedDetachedChild {
	readonly pid?: number;
	readonly processGroupId?: number;
	readonly exited?: boolean | (() => boolean);
	readonly kill?: (signal?: TerminalSessionSignal) => MaybePromise<unknown>;
}

export interface SessionRegistrySession {
	readonly command?: string;
	readonly exited?: boolean;
	readonly isExited?: boolean | (() => boolean);
	readonly exitResult?: unknown;
	readonly exitState?: { readonly status?: string };
	readonly status?: string;
	readonly trackedDetachedChildren?: readonly TrackedDetachedChild[];
	readonly getTrackedDetachedChildren?: () => readonly TrackedDetachedChild[];
	readonly onExit?: (handler: () => void) => (() => void) | undefined;
	readonly stop?: () => MaybePromise<unknown>;
	readonly kill?: (signal?: TerminalSessionSignal) => MaybePromise<unknown>;
	readonly signal?: (signal: TerminalSessionSignal) => MaybePromise<unknown>;
	readonly waitExit?: () => Promise<unknown>;
	readonly wait?: () => Promise<unknown>;
}

export interface SessionRegistryCreateOptions<TSession extends SessionRegistrySession = SessionRegistrySession> {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cols?: number;
	readonly rows?: number;
	readonly session?: TSession;
}

export interface SessionRegistryCreateContext {
	readonly id: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cols?: number;
	readonly rows?: number;
}

export interface InitialSessionRegistryEntry<TSession extends SessionRegistrySession = SessionRegistrySession> {
	readonly id: string;
	readonly session: TSession;
	readonly command?: string;
}

export interface SessionRegistryEntry<TSession extends SessionRegistrySession = SessionRegistrySession> {
	readonly id: string;
	readonly command: string;
	readonly session: TSession;
	readonly createdAt: number;
	readonly lastUsedAt: number;
	readonly state: TerminalSessionState;
	readonly exitedAt: number | null;
}

export interface SessionRegistrySweepOptions {
	readonly remove?: boolean;
}

export interface SessionRegistryOptions<TSession extends SessionRegistrySession = SessionRegistrySession> {
	readonly maxSessions?: number;
	readonly initialSessions?: readonly InitialSessionRegistryEntry<TSession>[];
	readonly createSession?: (options: SessionRegistryCreateContext) => MaybePromise<TSession>;
	readonly killProcess?: (target: number, signal: TerminalSessionSignal) => void;
	readonly now?: () => number;
	readonly platform?: string;
	/**
	 * How long `stop()` waits for a killed session to report exit before marking
	 * it `stopping` and returning. Guards against sessions whose exit never
	 * settles (e.g. a surviving descendant holding the PTY open). Default 5s.
	 */
	readonly stopExitGraceMs?: number;
}

export type StoredSessionRegistryEntry<TSession extends SessionRegistrySession> = {
	id: string;
	command: string;
	session: TSession;
	createdAt: number;
	lastUsedAt: number;
	state: TerminalSessionState;
	exitedAt: number | null;
	unsubscribeExit: (() => void) | null;
	stopPromise: Promise<boolean> | null;
	detachedCleanupPromise: Promise<void> | null;
};

export class SessionRegistryCapacityError extends Error {
	readonly code = "session_registry_capacity";
	readonly maxSessions: number;

	constructor(maxSessions: number) {
		super(`Cannot create terminal session: all ${maxSessions} registry slots are live.`);
		this.name = "SessionRegistryCapacityError";
		this.maxSessions = maxSessions;
	}
}
