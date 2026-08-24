import { randomUUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	linkSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionSourceExpectation,
	SessionStartEvent,
	SessionToolPolicy,
} from "./extensions/index.ts";
import { type ExtensionRunner, emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";
import { SESSION_TOOL_POLICY_ENTRY_TYPE } from "./session-tool-policy.ts";

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
}

interface InitializedSessionFileClaim {
	sessionFile: string;
	dev: number;
	ino: number;
	fd?: number;
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
	private readonly _launchProfile?: Readonly<AgentSessionLaunchProfile>;
	private readonly renameSessionFile: (source: string, destination: string) => void;
	private readonly unlinkSessionFile: (sessionFile: string) => void;
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
		unlinkSessionFile: (sessionFile: string) => void = unlinkSync,
		renameSessionFile: (source: string, destination: string) => void = renameSync,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this._launchProfile = launchProfile;
		this.unlinkSessionFile = unlinkSessionFile;
		this.renameSessionFile = renameSessionFile;
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

	private matchesExpectedSessionFile(sessionPath: string | undefined, expectedSessionId: string | undefined): boolean {
		if (expectedSessionId === undefined) return true;
		if (sessionPath === undefined) return false;
		try {
			return SessionManager.inspectMetadata(sessionPath)?.id === expectedSessionId;
		} catch {
			return false;
		}
	}

	private matchesExpectedSource(expectedSource: SessionSourceExpectation | undefined): boolean {
		if (!expectedSource) return true;
		if (this.session.sessionManager.getSessionId() !== expectedSource.sessionId) return false;
		if (this.session.sourceActivityGeneration !== expectedSource.activityGeneration) return false;
		if (!expectedSource.wasIdle) return true;
		return this.session.isIdle && this.session.sessionManager.getLeafId() === expectedSource.leafId;
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

	private async teardownCurrent(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
	): Promise<SessionManager> {
		// Settle the active response before replacement so the outgoing turn and
		// any completed tool results are persisted to the old session.
		this.session.beginReplacement();
		await this.session.abort();
		const outgoingSnapshot = this.session.sessionManager.cloneInMemory();
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
		this.beforeSessionInvalidate?.();
		this.session.dispose();
		return outgoingSnapshot;
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

	private async shutdownDiscardedRuntime(
		result: CreateAgentSessionRuntimeResult,
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
	): Promise<void> {
		await emitSessionShutdownEvent(result.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		result.session.dispose();
	}

	private async apply(result: CreateAgentSessionRuntimeResult): Promise<void> {
		result.session.beginReplacement();
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		await this.reportRemovedExtensions();
	}

	private async recoverAfterCancelledTeardown(input: {
		cwd: string;
		outgoingSnapshot: SessionManager;
		projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		sessionDir: string;
		sessionFile: string | undefined;
	}): Promise<void> {
		let sessionManager = input.outgoingSnapshot;
		if (input.sessionFile) {
			try {
				if (SessionManager.inspectMetadata(input.sessionFile)?.id === input.outgoingSnapshot.getSessionId()) {
					sessionManager = SessionManager.open(input.sessionFile, input.sessionDir, input.cwd);
				}
			} catch {
				// Keep the detached outgoing snapshot when metadata or persisted content is unreadable.
			}
		}
		const createRecoveryRuntime = (manager: SessionManager) =>
			this.createRuntime({
				cwd: manager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager: manager,
				sessionStartEvent: {
					type: "session_start",
					reason: "resume",
					previousSessionFile: input.sessionFile,
				},
				projectTrustContext: input.projectTrustContextFactory?.(manager.getCwd()),
				launchProfile: this._launchProfile,
			});
		let replacement = await createRecoveryRuntime(sessionManager);
		if (
			sessionManager !== input.outgoingSnapshot &&
			!this.matchesExpectedSessionFile(input.sessionFile, input.outgoingSnapshot.getSessionId())
		) {
			await this.shutdownDiscardedRuntime(replacement, "resume", input.sessionFile);
			sessionManager = input.outgoingSnapshot;
			replacement = await createRecoveryRuntime(sessionManager);
		}
		await this.apply(replacement);
		await this.finishSessionReplacement();
	}

	private async finishSessionReplacement(
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
		validateAfterRebind?: () => boolean,
	): Promise<boolean> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (validateAfterRebind && !validateAfterRebind()) {
			return false;
		}
		try {
			if (withSession) {
				await withSession(this.session.createReplacedSessionContext());
			}
		} finally {
			this.session.endReplacement();
		}
		return true;
	}

	private removeOwnedPersistedSession(sessionManager: SessionManager): void {
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) return;
		try {
			if (SessionManager.inspectMetadata(sessionFile)?.id !== sessionManager.getSessionId()) return;
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		const quarantinedFile = `${sessionFile}.cleanup-${randomUUID()}`;
		try {
			this.renameSessionFile(sessionFile, quarantinedFile);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		const restoreQuarantinedFile = (): void => {
			linkSync(quarantinedFile, sessionFile);
			unlinkSync(quarantinedFile);
		};
		try {
			if (SessionManager.inspectMetadata(quarantinedFile)?.id !== sessionManager.getSessionId()) {
				restoreQuarantinedFile();
				return;
			}
			this.unlinkSessionFile(quarantinedFile);
		} catch (error) {
			if (existsSync(quarantinedFile) && !existsSync(sessionFile)) {
				try {
					restoreQuarantinedFile();
				} catch (restoreError) {
					throw new AggregateError(
						[error, restoreError],
						`Failed to clean up or restore cancelled session ${sessionFile}`,
					);
				}
			}
			throw error;
		}
	}

	private claimInitializedSessionFile(sessionManager: SessionManager): InitializedSessionFileClaim | undefined {
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) return undefined;
		let created = false;
		let fd: number | undefined;
		try {
			fd = openSync(sessionFile, "wx");
			created = true;
			const identity = fstatSync(fd);
			return { sessionFile, dev: identity.dev, ino: identity.ino, fd };
		} catch (error) {
			if (fd !== undefined) closeSync(fd);
			if (created && existsSync(sessionFile)) {
				try {
					this.unlinkSessionFile(sessionFile);
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						`Failed to claim or clean up initialized session ${sessionFile}`,
					);
				}
			}
			throw error;
		}
	}

	private persistInitializedSessionThroughClaim(
		sessionManager: SessionManager,
		claim: InitializedSessionFileClaim,
	): void {
		const fd = claim.fd;
		if (fd === undefined) throw new Error(`Initialized session claim is already closed: ${claim.sessionFile}`);
		let persistenceError: unknown;
		try {
			sessionManager.persistInitializedSession(fd);
		} catch (error) {
			persistenceError = error;
		}
		claim.fd = undefined;
		try {
			closeSync(fd);
		} catch (error) {
			if (persistenceError) {
				throw new AggregateError(
					[persistenceError, error],
					`Failed to persist or close initialized session ${claim.sessionFile}`,
				);
			}
			throw error;
		}
		if (persistenceError) throw persistenceError;

		let identity: ReturnType<typeof statSync>;
		try {
			identity = statSync(claim.sessionFile);
		} catch (error) {
			throw new Error(`Session path changed during initialized persistence: ${claim.sessionFile}`, {
				cause: error,
			});
		}
		if (identity.dev !== claim.dev || identity.ino !== claim.ino) {
			throw new Error(`Session path changed during initialized persistence: ${claim.sessionFile}`);
		}
	}

	private removeClaimedInitializedSessionFile(claim: InitializedSessionFileClaim): void {
		const quarantinedFile = `${claim.sessionFile}.cleanup-${randomUUID()}`;
		try {
			this.renameSessionFile(claim.sessionFile, quarantinedFile);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
			throw error;
		}

		let identity: ReturnType<typeof statSync>;
		try {
			identity = statSync(quarantinedFile);
		} catch (error) {
			try {
				this.restoreQuarantinedInitializedSessionFile(quarantinedFile, claim.sessionFile);
			} catch (restoreError) {
				throw new AggregateError(
					[error, restoreError],
					`Failed to inspect or restore initialized session ${claim.sessionFile}`,
				);
			}
			throw error;
		}
		if (identity.dev !== claim.dev || identity.ino !== claim.ino) {
			this.restoreQuarantinedInitializedSessionFile(quarantinedFile, claim.sessionFile);
			return;
		}
		this.unlinkSessionFile(quarantinedFile);
	}

	private restoreQuarantinedInitializedSessionFile(quarantinedFile: string, sessionFile: string): void {
		for (let attempt = 0; attempt < 32; attempt++) {
			try {
				linkSync(quarantinedFile, sessionFile);
				unlinkSync(quarantinedFile);
				return;
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
					throw error;
				}
			}
			const recoveryFile = `${sessionFile}.recovery-${randomUUID()}`;
			try {
				this.renameSessionFile(sessionFile, recoveryFile);
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
		}
		throw new Error(`Failed to restore initialized session after repeated path recreation: ${sessionFile}`);
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			expectedSessionId?: string;
			expectedSource?: SessionSourceExpectation;
			sessionDir?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		if (!this.matchesExpectedSource(options?.expectedSource)) {
			return { cancelled: true };
		}

		const previousSessionFile = this.session.sessionFile;
		const previousSession = {
			cwd: this.session.sessionManager.getCwd(),
			sessionDir: this.session.sessionManager.getSessionDir(),
			sessionFile: previousSessionFile,
		};
		let sessionManager = SessionManager.open(sessionPath, options?.sessionDir, options?.cwdOverride);
		if (options?.expectedSessionId && sessionManager.getSessionId() !== options.expectedSessionId) {
			return { cancelled: true };
		}
		assertSessionCwdExists(sessionManager, this.cwd);
		const outgoingSnapshot = await this.teardownCurrent("resume", sessionManager.getSessionFile());
		if (options?.expectedSessionId) {
			let refreshedSessionManager: SessionManager | undefined;
			try {
				const candidate = SessionManager.open(sessionPath, options.sessionDir, options.cwdOverride);
				if (candidate.getSessionId() === options.expectedSessionId) {
					assertSessionCwdExists(candidate, this.cwd);
					refreshedSessionManager = candidate;
				}
			} catch {
				// Treat an unreadable or invalidated destination as a cancelled switch.
			}
			if (!refreshedSessionManager) {
				await this.recoverAfterCancelledTeardown({
					...previousSession,
					outgoingSnapshot,
					projectTrustContextFactory: options.projectTrustContextFactory,
				});
				return { cancelled: true };
			}
			sessionManager = refreshedSessionManager;
		}
		const replacement = await this.createRuntime({
			cwd: sessionManager.getCwd(),
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			launchProfile: this._launchProfile,
		});
		if (options?.expectedSessionId && !this.matchesExpectedSessionFile(sessionPath, options.expectedSessionId)) {
			await this.shutdownDiscardedRuntime(replacement, "resume", previousSessionFile);
			await this.recoverAfterCancelledTeardown({
				...previousSession,
				outgoingSnapshot,
				projectTrustContextFactory: options.projectTrustContextFactory,
			});
			return { cancelled: true };
		}
		await this.apply(replacement);
		if (options?.expectedSessionId && !this.matchesExpectedSessionFile(sessionPath, options.expectedSessionId)) {
			await this.teardownCurrent("resume", previousSessionFile);
			await this.recoverAfterCancelledTeardown({
				...previousSession,
				outgoingSnapshot,
				projectTrustContextFactory: options.projectTrustContextFactory,
			});
			return { cancelled: true };
		}
		const finished = await this.finishSessionReplacement(
			options?.withSession,
			options?.expectedSessionId
				? () => this.matchesExpectedSessionFile(sessionPath, options.expectedSessionId)
				: undefined,
		);
		if (!finished) {
			await this.teardownCurrent("resume", previousSessionFile);
			await this.recoverAfterCancelledTeardown({
				...previousSession,
				outgoingSnapshot,
				projectTrustContextFactory: options?.projectTrustContextFactory,
			});
			return { cancelled: true };
		}
		return { cancelled: false };
	}

	async newSession(options?: {
		expectedParentSessionId?: string;
		expectedSource?: SessionSourceExpectation;
		parentSession?: string;
		persistInitializedSession?: boolean;
		sessionToolPolicy?: SessionToolPolicy;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		if (!this.matchesExpectedSource(options?.expectedSource)) {
			return { cancelled: true };
		}
		if (!this.matchesExpectedSessionFile(options?.parentSession, options?.expectedParentSessionId)) {
			return { cancelled: true };
		}

		const previousSessionFile = this.session.sessionFile;
		const previousSession = {
			cwd: this.session.sessionManager.getCwd(),
			sessionDir: this.session.sessionManager.getSessionDir(),
			sessionFile: previousSessionFile,
		};
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}
		if (options?.sessionToolPolicy) {
			sessionManager.appendCustomEntry(SESSION_TOOL_POLICY_ENTRY_TYPE, options.sessionToolPolicy);
		}

		const outgoingSnapshot = await this.teardownCurrent("new", sessionManager.getSessionFile());
		if (!this.matchesExpectedSessionFile(options?.parentSession, options?.expectedParentSessionId)) {
			await this.recoverAfterCancelledTeardown({ ...previousSession, outgoingSnapshot });
			return { cancelled: true };
		}
		const replacement = await this.createRuntime({
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			launchProfile: this._launchProfile,
		});
		if (!this.matchesExpectedSessionFile(options?.parentSession, options?.expectedParentSessionId)) {
			await this.shutdownDiscardedRuntime(replacement, "new", previousSessionFile);
			await this.recoverAfterCancelledTeardown({ ...previousSession, outgoingSnapshot });
			return { cancelled: true };
		}
		await this.apply(replacement);
		if (!this.matchesExpectedSessionFile(options?.parentSession, options?.expectedParentSessionId)) {
			await this.teardownCurrent("new", previousSessionFile);
			await this.recoverAfterCancelledTeardown({ ...previousSession, outgoingSnapshot });
			return { cancelled: true };
		}
		let initializedSessionFileClaim: InitializedSessionFileClaim | undefined;
		try {
			if (options?.setup) {
				await options.setup(this.session.sessionManager);
				this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
			}
			if (options?.persistInitializedSession) {
				initializedSessionFileClaim = this.claimInitializedSessionFile(this.session.sessionManager);
				if (initializedSessionFileClaim) {
					this.persistInitializedSessionThroughClaim(this.session.sessionManager, initializedSessionFileClaim);
				} else {
					this.session.sessionManager.persistInitializedSession();
				}
			}
		} catch (operationError) {
			const recoveryErrors: unknown[] = [];
			this.session.sessionManager.detachPersistenceWrites();
			try {
				await this.teardownCurrent("new", previousSessionFile);
			} catch (error) {
				recoveryErrors.push(error);
			}
			if (options?.persistInitializedSession) {
				try {
					if (initializedSessionFileClaim) this.removeClaimedInitializedSessionFile(initializedSessionFileClaim);
				} catch (error) {
					recoveryErrors.push(error);
				}
			}
			try {
				await this.recoverAfterCancelledTeardown({ ...previousSession, outgoingSnapshot });
			} catch (error) {
				recoveryErrors.push(error);
			}
			if (recoveryErrors.length > 0) {
				throw new AggregateError(
					[operationError, ...recoveryErrors],
					"Failed to recover after new-session setup or persistence failed",
				);
			}
			throw operationError;
		}
		const finished = await this.finishSessionReplacement(
			options?.withSession,
			options?.expectedParentSessionId
				? () => this.matchesExpectedSessionFile(options.parentSession, options.expectedParentSessionId)
				: undefined,
		);
		if (!finished) {
			const cancelledSessionManager = this.session.sessionManager;
			await this.teardownCurrent("new", previousSessionFile);
			let cleanupError: unknown;
			if (options?.persistInitializedSession) {
				try {
					this.removeOwnedPersistedSession(cancelledSessionManager);
				} catch (error) {
					cleanupError = error;
				}
			}
			await this.recoverAfterCancelledTeardown({ ...previousSession, outgoingSnapshot });
			if (cleanupError) throw cleanupError;
			return { cancelled: true };
		}
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
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
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
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
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

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
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
	}
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
		unlinkSessionFile?: (sessionFile: string) => void;
		renameSessionFile?: (source: string, destination: string) => void;
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
		options.unlinkSessionFile,
		options.renameSessionFile,
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
