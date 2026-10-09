import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type { BrowserEngine } from "./browser-engine.ts";
import type { PromptSurface } from "./dynamic-prompt/types.ts";
import type { HostMcpRegistry } from "./extensions/builtin/mcp/host-registry.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionContext,
	SessionKind,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { type ExtensionRunner, emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { holdSessionFile, type SessionHold } from "./session-holders.ts";
import { SessionManager } from "./session-manager.ts";
import { reserveSessionWrite, unregisterSessionWriter } from "./session-write-reservation.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { resetTimings, time } from "./timings.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/** Immutable flags selected when a runtime is first launched. */
export interface AgentSessionLaunchProfile {
	cwd: string;
	permissionPreset?: string;
	creationModel?: { provider: string; modelId: string };
	initialThinkingLevel?: string;
	/**
	 * Visibility class of this session (`open_session.kind`), absent for classic
	 * launches. It reaches the extensions this session loads and nothing else: it
	 * never takes part in auth, model or resource resolution.
	 */
	sessionKind?: SessionKind;
	/** Opaque labels the opener attached (`open_session.context`), absent when none. */
	sessionContext?: SessionContext;
	/**
	 * Per-session auto-titling (`open_session.auto_title`). When set, this session
	 * ignores the host-wide `--auto-title-sessions` / appMode default.
	 */
	autoTitle?: boolean;
	/** Per-session prompt surface (`open_session.promptSurface`); absent means `SENPI_PROMPT_SURFACE`. */
	promptSurface?: PromptSurface;
	/** Per-session browser engine (`open_session.browserEngine`); absent means none was chosen. */
	browserEngine?: BrowserEngine;
	/**
	 * Per-session retry fallback (`open_session.retryFallback`): applied to THIS session's settings as an
	 * in-memory override that is never written to a settings file, so one session's chain never reaches
	 * another session on the host or the user's settings. Absent means the host's settings decide.
	 */
	retryFallback?: SessionRetryFallbackProfile;
}

/** The fallback policy one session runs with, chosen by its opener (e.g. a task child's own chain). */
export interface SessionRetryFallbackProfile {
	readonly modelFallback: boolean;
	/** Chain key (selector, optionally `:thinking`) to its ordered fallback selectors. */
	readonly fallbackChains: Readonly<Record<string, readonly string[]>>;
}

/** Overlays a session's fallback policy on its settings in memory: never saved, never shared. */
export function applyRetryFallbackProfile(
	settingsManager: SettingsManager,
	profile: SessionRetryFallbackProfile,
): void {
	settingsManager.applyOverrides({
		retry: {
			modelFallback: profile.modelFallback,
			fallbackChains: Object.fromEntries(
				Object.entries(profile.fallbackChains).map(([key, entries]) => [key, [...entries]]),
			),
		},
	});
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	mcpRegistry?: HostMcpRegistry;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
	launchProfile?: Readonly<AgentSessionLaunchProfile>;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private _launchProfile?: Readonly<AgentSessionLaunchProfile>;
	// Advertises the open session file to other processes so none moves it out from under this one.
	private _sessionHold?: SessionHold;
	private _removedOnReplacement?: {
		oldRunner: ExtensionRunner;
		oldIdentities: Array<{ path: string; resolvedPath: string }>;
		reason: SessionShutdownEvent["reason"];
	};

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		launchProfile?: Readonly<AgentSessionLaunchProfile>,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this._launchProfile = launchProfile;
		this._sessionHold = holdActiveSession(_session.sessionManager, wasFlushed(_session.sessionManager));
	}

	/** Stops advertising the open session to other processes; a runtime that replaces this one holds its own. */
	releaseSessionHold(): void {
		this._sessionHold?.release();
		this._sessionHold = undefined;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	get launchProfile(): Readonly<AgentSessionLaunchProfile> | undefined {
		return this._launchProfile;
	}

	/** Moves this session to another prompt surface; later replacements (switch, new, fork) keep it. */
	setPromptSurface(surface: PromptSurface): void {
		this._launchProfile = Object.freeze({ ...(this._launchProfile ?? { cwd: this.cwd }), promptSurface: surface });
		this._session.setPromptSurface(surface);
	}

	/** Moves this session to another browser engine; later replacements (switch, new, fork) keep it. */
	setBrowserEngine(engine: BrowserEngine): void {
		this._launchProfile = Object.freeze({ ...(this._launchProfile ?? { cwd: this.cwd }), browserEngine: engine });
		this._session.setBrowserEngine(engine);
	}

	/**
	 * Moves this session to another permission preset (a later `open_session.permissionPreset`): the
	 * permission extension enforces it from the next tool call, and later replacements (switch, new,
	 * fork) keep it.
	 */
	setPermissionPreset(preset: string): void {
		this._launchProfile = Object.freeze({ ...(this._launchProfile ?? { cwd: this.cwd }), permissionPreset: preset });
		this._session.extensionRunner.setFlagValue("permission-preset", preset);
	}

	/**
	 * Gives this process's sessions their fallback policy (`set_retry_fallback`); later replacements
	 * (switch, new, fork) keep it. Callers set it before the first turn: a chain never changes under a
	 * retry already in flight.
	 */
	setRetryFallback(profile: SessionRetryFallbackProfile): void {
		const retryFallback = Object.freeze({
			modelFallback: profile.modelFallback,
			fallbackChains: Object.freeze(
				Object.fromEntries(
					Object.entries(profile.fallbackChains).map(([key, entries]) => [key, Object.freeze([...entries])]),
				),
			),
		});
		this._launchProfile = Object.freeze({ ...(this._launchProfile ?? { cwd: this.cwd }), retryFallback });
		applyRetryFallbackProfile(this._session.settingsManager, retryFallback);
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	/** Attachment transitions are ordered by the RPC entry's lifecycle mutex. */
	async emitAttachmentEvent(type: "session_parked" | "session_resumed"): Promise<void> {
		const runner = this.session.extensionRunner;
		if (runner.hasHandlers(type)) await runner.emit({ type });
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		const mark = (label: string): void => {
			if (reason === "resume") time(label, "switch");
		};
		// Settle the active response before replacement so the outgoing turn and
		// any completed tool results are persisted to the old session.
		await this.session.abort();
		mark("abort");
		const oldRunner = this.session.extensionRunner;
		// Test hosts and partial runner implementations may lack identity introspection;
		// skip removal reporting there rather than break the replacement itself.
		if (typeof oldRunner.getExtensionIdentities === "function") {
			this._removedOnReplacement = {
				oldRunner,
				oldIdentities: oldRunner.getExtensionIdentities(),
				reason,
			};
		}
		await emitSessionShutdownEvent(oldRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		mark("shutdown");
		this.beforeSessionInvalidate?.();
		const replaced = this.session.sessionManager;
		this.session.dispose();
		// Nothing writes to the replaced manager once its session is disposed, so the
		// shared host may hand its session file to another worker.
		unregisterSessionWriter(replaced);
		this.releaseSessionHold();
		mark("dispose");
	}

	private async reportRemovedExtensions(): Promise<void> {
		const pending = this._removedOnReplacement;
		this._removedOnReplacement = undefined;
		if (!pending) return;
		const newRunner = this.session.extensionRunner;
		if (typeof newRunner.getExtensionIdentities !== "function") return;
		const newResolvedPaths = new Set(newRunner.getExtensionIdentities().map((extension) => extension.resolvedPath));
		const removed = pending.oldIdentities.filter((extension) => !newResolvedPaths.has(extension.resolvedPath));
		if (removed.length === 0) return;
		await pending.oldRunner.emit({ type: "session_extensions_removed", reason: pending.reason, removed });
	}

	private async apply(result: CreateAgentSessionRuntimeResult, hold?: SessionHold): Promise<void> {
		this._sessionHold = hold ?? holdActiveSession(result.session.sessionManager, false);
		this._session = result.session;
		// The replacement was built from the profile read before its runtime was created; an attach
		// that moved a setting while it was being built reached only the retired session (senpi#2842).
		const profile = this._launchProfile;
		if (profile?.permissionPreset !== undefined)
			this._session.extensionRunner.setFlagValue("permission-preset", profile.permissionPreset);
		if (profile?.promptSurface !== undefined) this._session.setPromptSurface(profile.promptSurface);
		if (profile?.browserEngine !== undefined) this._session.setBrowserEngine(profile.browserEngine);
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		await this.reportRemovedExtensions();
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		resetTimings("switch");
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		time("beforeSwitch", "switch");

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		// Held before the current session is torn down: a session being moved fails the switch here.
		const hold = holdActiveSession(sessionManager, wasFlushed(sessionManager));
		time("open", "switch");
		try {
			await this.teardownCurrent("resume", sessionManager.getSessionFile());
			await this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
					projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
					launchProfile: this._launchProfile,
				}),
				hold,
			);
		} catch (error) {
			if (this._sessionHold !== hold) hold?.release();
			throw error;
		}
		time("apply", "switch");
		await this.finishSessionReplacement(options?.withSession);
		time("rebind", "switch");
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		await this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
				launchProfile: this._launchProfile,
			}),
		);
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.session.refreshContext();
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				await this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
						launchProfile: this._launchProfile,
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error("This session has not been saved yet. Send a message before cloning or forking it.");
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			await this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					launchProfile: this._launchProfile,
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				launchProfile: this._launchProfile,
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		let destinationPath = join(sessionDir, basename(resolvedPath));
		const sourceAlreadyStored = resolve(destinationPath) === resolvedPath;
		if (!sourceAlreadyStored) {
			const { name, ext } = parse(destinationPath);
			let suffix = 1;
			while (existsSync(destinationPath)) {
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		reserveSessionWrite(destinationPath);
		if (!sourceAlreadyStored) {
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		await this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				launchProfile: this._launchProfile,
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async dispose(): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
		this.releaseSessionHold();
	}
}

// A persisted session is written to disk with its first assistant message, so one that has an
// assistant message and no file was moved away after it was read.
function wasFlushed(sessionManager: SessionManager): boolean {
	return sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant");
}

function holdActiveSession(sessionManager: SessionManager, expectExisting: boolean): SessionHold | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionManager.isPersisted() || sessionFile === undefined) return undefined;
	return holdSessionFile(sessionFile, sessionManager.getSessionId(), {
		cwd: sessionManager.getCwd(),
		expectExisting,
	});
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
		launchProfile?: Readonly<AgentSessionLaunchProfile>;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
		options.launchProfile,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
