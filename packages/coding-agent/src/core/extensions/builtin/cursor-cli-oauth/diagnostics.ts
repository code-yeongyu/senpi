import type { Credential } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionExtensionsRemovedEvent,
	SessionShutdownEvent,
} from "../../types.ts";
import { type CursorCliAccountSlot, type CursorCliOauthCredential, emptyCredential, listAccounts } from "./accounts.ts";
import { selectAccount } from "./affinity.ts";
import {
	CursorAgentNotInstalledError,
	defaultCursorAgentExecutableDeps,
	probeCursorAgentVersion,
	resolveCursorAgentExecutable,
} from "./executable.ts";
import { type CursorCliSessionRouter, cursorCliSessionRouter } from "./session-router.ts";
import type { CursorCliOauthProviderSettings } from "./settings.ts";
import {
	CURSOR_CLI_ABORT_GRACE_MS,
	type CursorCliTransportHandle,
	type CursorCliTransportInput,
	spawnCursorCli,
} from "./transport.ts";

/** Minimum known-good cursor-agent version; below it senpi warns once per session but never blocks. */
export const CURSOR_CLI_MINIMUM_KNOWN_GOOD_VERSION = "2026.08.11";
/** This lane always authenticates through per-account sandboxed HOME file stores. */
export const CURSOR_CLI_STATUS_LANE = "file-store";
/** senpi never delegates compaction on this lane, so it is always the context owner. */
export const CURSOR_CLI_STATUS_CONTEXT_OWNER = "senpi";
/** The native Cursor provider id; the recommended default when both providers are configured. */
export const NATIVE_CURSOR_PROVIDER_ID = "cursor";

// ============================================================================
// Status diagnostics
// ============================================================================

export type CursorCliBlockWindow = {
	readonly account: string;
	readonly reason: "rate_limit" | "auth_error";
	/** Expiry timestamp; undefined means blocked until the account logs in again. */
	readonly blockedUntil: number | undefined;
};

export type CursorCliStatusReport = {
	readonly lane: typeof CURSOR_CLI_STATUS_LANE;
	readonly selectedAccount: string | undefined;
	readonly pinnedAccount: string | undefined;
	readonly chatId: string | undefined;
	readonly lastModel: string | undefined;
	readonly contextOwner: typeof CURSOR_CLI_STATUS_CONTEXT_OWNER;
	readonly executablePath: string | undefined;
	readonly executableVersion: string | undefined;
	readonly minimumKnownGoodVersion: string;
	readonly belowMinimumKnownGood: boolean;
	readonly executableProblem: string | undefined;
	readonly blockWindows: readonly CursorCliBlockWindow[];
	readonly accountNames: readonly string[];
	readonly nativeCursorConfigured: boolean;
};

export type CursorCliStatusDeps = {
	readonly sessionId: string;
	readonly settings: CursorCliOauthProviderSettings;
	readonly readCredential: () => Credential | undefined | Promise<Credential | undefined>;
	readonly readNativeCredential?: () => Credential | undefined | Promise<Credential | undefined>;
	readonly router?: CursorCliSessionRouter;
	readonly resolveExecutable?: (settings: CursorCliOauthProviderSettings) => string;
	readonly probeVersion?: (executable: string) => Promise<string>;
	readonly now?: () => number;
};

function asCursorCredential(value: Credential | undefined): CursorCliOauthCredential {
	return value !== undefined && value.type === "oauth" ? (value as CursorCliOauthCredential) : emptyCredential();
}

function isUsableOAuthCredential(value: Credential | undefined): boolean {
	return value !== undefined && value.type === "oauth" && typeof value.access === "string" && value.access.length > 0;
}

export function parseCursorCliVersion(version: string): { year: number; month: number; day: number } | undefined {
	const match = /^v?(\d{1,4})\.(\d{1,2})\.(\d{1,2})/.exec(version.trim());
	if (!match) return undefined;
	return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Compares two `YYYY.MM.DD[-suffix]` version strings; undefined when either cannot be parsed. */
export function compareCursorCliVersions(version: string, floor: string): number | undefined {
	const parsed = parseCursorCliVersion(version);
	const baseline = parseCursorCliVersion(floor);
	if (parsed === undefined || baseline === undefined) return undefined;
	const left = [parsed.year, parsed.month, parsed.day] as const;
	const right = [baseline.year, baseline.month, baseline.day] as const;
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
	}
	return 0;
}

function blockWindowFor(account: CursorCliAccountSlot, now: number): CursorCliBlockWindow | undefined {
	if (account.blockReason === "auth_error") {
		return { account: account.name, reason: "auth_error", blockedUntil: undefined };
	}
	if (account.blockedUntil !== undefined && account.blockedUntil > now) {
		return { account: account.name, reason: "rate_limit", blockedUntil: account.blockedUntil };
	}
	return undefined;
}

const defaultResolveExecutable = (settings: CursorCliOauthProviderSettings): string =>
	resolveCursorAgentExecutable({
		...defaultCursorAgentExecutableDeps(),
		settings: { executablePath: settings.executablePath },
	});

/**
 * Collects the status snapshot. Account data is read fresh from the credential
 * store on every call - never memoized - so the rendered state always matches
 * the store even after concurrent logins, removals, or failover blocks. Only
 * account names and metadata are extracted; tokens never enter the report.
 */
export async function collectCursorCliStatus(deps: CursorCliStatusDeps): Promise<CursorCliStatusReport> {
	const now = deps.now ?? Date.now;
	const credential = asCursorCredential(await deps.readCredential());
	const accounts = listAccounts(credential);
	const pinnedAccount = deps.settings.pinnedAccount ?? credential.pinned;
	const record = (deps.router ?? cursorCliSessionRouter).getRecord(deps.sessionId);

	let selectedAccount = record?.accountName;
	if (selectedAccount === undefined && accounts.length > 0) {
		try {
			selectedAccount = selectAccount(accounts, {
				sessionId: deps.sessionId,
				pinnedAccount,
				now: now(),
			}).name;
		} catch {
			// Every account is blocked; report no selection instead of failing status.
		}
	}

	let executablePath: string | undefined;
	let executableProblem: string | undefined;
	try {
		executablePath = (deps.resolveExecutable ?? defaultResolveExecutable)(deps.settings);
	} catch (error) {
		executableProblem = error instanceof Error ? error.message : String(error);
		if (!(error instanceof CursorAgentNotInstalledError)) executablePath = undefined;
	}

	let executableVersion: string | undefined;
	if (executablePath !== undefined) {
		try {
			executableVersion = await (deps.probeVersion ?? probeCursorAgentVersion)(executablePath);
		} catch {
			// Version unknown; the floor warning only applies to parseable versions.
		}
	}
	const comparison =
		executableVersion === undefined
			? undefined
			: compareCursorCliVersions(executableVersion, CURSOR_CLI_MINIMUM_KNOWN_GOOD_VERSION);

	const nativeCredential = deps.readNativeCredential === undefined ? undefined : await deps.readNativeCredential();

	return {
		lane: CURSOR_CLI_STATUS_LANE,
		selectedAccount,
		pinnedAccount,
		chatId: record?.chatId,
		lastModel: record?.lastModel,
		contextOwner: CURSOR_CLI_STATUS_CONTEXT_OWNER,
		executablePath,
		executableVersion,
		minimumKnownGoodVersion: CURSOR_CLI_MINIMUM_KNOWN_GOOD_VERSION,
		belowMinimumKnownGood: comparison !== undefined && comparison < 0,
		executableProblem,
		blockWindows: accounts
			.map((account) => blockWindowFor(account, now()))
			.filter((window): window is CursorCliBlockWindow => window !== undefined),
		accountNames: accounts.map((account) => account.name),
		nativeCursorConfigured: isUsableOAuthCredential(nativeCredential),
	};
}

/** Pure renderer: names and metadata only, never token material. */
export function renderCursorCliStatus(report: CursorCliStatusReport): string {
	const lines: string[] = ["Cursor CLI (OAuth) status:"];
	lines.push(`  Auth lane: ${report.lane}`);
	lines.push(`  Context owner: ${report.contextOwner}`);
	lines.push(
		`  Selected account: ${
			report.selectedAccount === undefined
				? "none"
				: report.selectedAccount === report.pinnedAccount
					? `${report.selectedAccount} (pinned)`
					: report.selectedAccount
		}`,
	);
	lines.push(`  Chat id: ${report.chatId ?? "none (no turns yet on this session)"}`);
	lines.push(`  Last model: ${report.lastModel ?? "none"}`);
	if (report.executableProblem !== undefined) {
		lines.push(`  Executable: not installed - ${report.executableProblem}`);
	} else {
		lines.push(`  Executable: ${report.executablePath ?? "not installed"}`);
	}
	if (report.executableVersion !== undefined) lines.push(`  Version: ${report.executableVersion}`);
	if (report.belowMinimumKnownGood) {
		lines.push(
			`  WARNING: cursor-agent ${report.executableVersion} is below the minimum known-good ${report.minimumKnownGoodVersion}; upgrade recommended`,
		);
	}
	if (report.blockWindows.length === 0) {
		lines.push("  Block windows: none");
	} else {
		lines.push("  Block windows:");
		for (const window of report.blockWindows) {
			lines.push(
				window.blockedUntil === undefined
					? `    ${window.account}: ${window.reason}, until re-login`
					: `    ${window.account}: ${window.reason}, expires ${new Date(window.blockedUntil).toISOString()}`,
			);
		}
	}
	if (report.nativeCursorConfigured) {
		lines.push(
			`  Recommended default: the native '${NATIVE_CURSOR_PROVIDER_ID}' provider is configured; use this Cursor CLI (OAuth) lane as the fallback when the native path misbehaves.`,
		);
	}
	return lines.join("\n");
}

// ============================================================================
// Reload / shutdown safety (senpi #866 regression class)
// ============================================================================

export type CursorCliFencedOutcome<T> =
	| { readonly status: "completed"; readonly value: T }
	| { readonly status: "dropped"; readonly reason: string };

export type CursorCliDeferredContinuation<T> = {
	/** Runs the continuation through the fence, even if its timer was cancelled or already fired. */
	fire(): Promise<CursorCliFencedOutcome<T>>;
	cancel(): void;
};

export type CursorCliDroppedReporter = (description: string, reason: string) => void;

/**
 * A reload retires this extension generation (`AgentSession.reload()` then
 * invalidates the old runner) while timers and promise continuations captured
 * by it are still armed; every `ExtensionContext` getter then throws
 * "stale extension generation after reload". The context carries no liveness
 * flag, so a retired generation is only observable by probing a getter.
 */
export function isCursorCliContextRetired(ctx: ExtensionContext): boolean {
	try {
		ctx.isIdle();
		return false;
	} catch {
		return true;
	}
}

/** Per-registration generation fence; one per extension registration (a reload builds a new one). */
export class CursorCliGenerationGuard {
	private retired = false;
	private retirementReason: string | undefined;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private droppedReporter: CursorCliDroppedReporter | undefined;

	isRetired(): boolean {
		return this.retired;
	}

	retire(reason: string): void {
		if (this.retired) return;
		this.retired = true;
		this.retirementReason = `extension generation retired (${reason})`;
	}

	onDropped(reporter: CursorCliDroppedReporter): void {
		this.droppedReporter = reporter;
	}

	/** Arms a timer the shutdown path cancels; arming after retirement is a no-op by construction. */
	setTrackedTimeout(callback: () => void, delayMs: number): () => void {
		const timer = this.armTracked(callback, delayMs);
		return () => {
			if (timer !== undefined) this.cancelTimer(timer);
		};
	}

	/** Cancels every armed timer; returns how many were pending. */
	clearTrackedTimers(): number {
		const pending = this.timers.size;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		return pending;
	}

	/**
	 * Runs a deferred continuation behind the generation fence. A dropped
	 * continuation is reported, never silently presented as completed.
	 */
	async runFenced<T>(
		ctx: ExtensionContext,
		work: (ctx: ExtensionContext) => Promise<T> | T,
	): Promise<CursorCliFencedOutcome<T>> {
		const blockedReason = this.retirementReasonFor(ctx);
		if (blockedReason !== undefined) {
			this.reportDropped("deferred continuation", blockedReason);
			return { status: "dropped", reason: blockedReason };
		}
		return { status: "completed", value: await work(ctx) };
	}

	/** Synchronous variant for continuations that only touch the context once, after an outer await. */
	runFencedSync(ctx: ExtensionContext, work: () => void): { ran: boolean } {
		const blockedReason = this.retirementReasonFor(ctx);
		if (blockedReason !== undefined) {
			this.reportDropped("deferred continuation", blockedReason);
			return { ran: false };
		}
		work();
		return { ran: true };
	}

	defer<T>(
		ctx: ExtensionContext,
		work: (ctx: ExtensionContext) => Promise<T> | T,
		delayMs = 0,
	): CursorCliDeferredContinuation<T> {
		const fire = (): Promise<CursorCliFencedOutcome<T>> => this.runFenced(ctx, work);
		const timer = this.armTracked(() => {
			// The timer path has no caller to receive a rejection (senpi #866 crash
			// class), so a post-fence failure is reported instead of escaping to the
			// timer queue.
			void fire().catch((error: unknown) => {
				this.reportDropped(
					"deferred continuation",
					`failed after the retirement check: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}, delayMs);
		return {
			fire,
			cancel: () => {
				if (timer !== undefined) this.cancelTimer(timer);
			},
		};
	}

	private armTracked(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | undefined {
		if (this.retired) return undefined;
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			callback();
		}, delayMs);
		this.timers.add(timer);
		return timer;
	}

	private cancelTimer(timer: ReturnType<typeof setTimeout>): void {
		clearTimeout(timer);
		this.timers.delete(timer);
	}

	private retirementReasonFor(ctx: ExtensionContext): string | undefined {
		if (this.retired) return this.retirementReason ?? "extension generation retired";
		if (isCursorCliContextRetired(ctx)) return "extension context retired by reload";
		return undefined;
	}

	private reportDropped(description: string, reason: string): void {
		this.droppedReporter?.(description, reason);
	}
}

/** Process-group kill on the tracked pid, mirroring transport.ts's mechanism (never name matching). */
function killCursorCliProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		if (process.platform === "win32") process.kill(pid, signal);
		else process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

type TrackedCursorCliChild = {
	readonly pid: number;
	readonly abort: () => void;
	killed: boolean;
};

/**
 * Registry of live children this extension spawned. Entries leave the registry
 * when their transport run settles, so `killAll` only ever signals live
 * process groups and is idempotent across repeated interruptions.
 */
export class CursorCliChildRegistry {
	private readonly children = new Map<number, TrackedCursorCliChild>();

	track(handle: CursorCliTransportHandle): CursorCliTransportHandle {
		this.children.set(handle.pid, { pid: handle.pid, abort: () => handle.abort(), killed: false });
		void handle.completed.then(
			() => this.children.delete(handle.pid),
			() => this.children.delete(handle.pid),
		);
		return handle;
	}

	livePids(): number[] {
		return [...this.children.keys()];
	}

	/** SIGTERMs every tracked process group with a SIGKILL escalation; returns the pids it signalled. */
	killAll(graceMs: number = CURSOR_CLI_ABORT_GRACE_MS): number[] {
		const signalled: number[] = [];
		for (const entry of this.children.values()) {
			if (entry.killed) continue;
			entry.killed = true;
			signalled.push(entry.pid);
			// Teardown must never throw into the shutdown event loop; individual
			// failures are contained per child, and the SIGKILL escalation below
			// still runs for that pid.
			try {
				entry.abort();
			} catch {
				// Deliberate: shutdown stays idempotent even if one child misbehaves.
			}
			try {
				killCursorCliProcessGroup(entry.pid, "SIGTERM");
			} catch {
				// Deliberate: see above.
			}
			const escalation = setTimeout(() => killCursorCliProcessGroup(entry.pid, "SIGKILL"), graceMs);
			escalation.unref?.();
		}
		return signalled;
	}
}

/** Shared registry; child pids are process-wide resources, so one registry serves every generation. */
export const cursorCliChildRegistry = new CursorCliChildRegistry();

/** Spawns one cursor-agent run through the transport and registers it for shutdown teardown. */
export function spawnCursorCliTracked(
	input: CursorCliTransportInput,
	registry: CursorCliChildRegistry = cursorCliChildRegistry,
): CursorCliTransportHandle {
	return registry.track(spawnCursorCli(input));
}

export type CursorCliShutdownSafetyDeps = {
	readonly generation?: CursorCliGenerationGuard;
	readonly registry?: CursorCliChildRegistry;
};

/**
 * Installs the `session_shutdown`/`session_extensions_removed` teardown: kill
 * every tracked child's process group, cancel the generation's pending timers,
 * and retire the generation so every deferred continuation is fenced. Safe to
 * fire repeatedly; a retired generation is never resurrected (a reload builds a
 * new registration with a fresh guard).
 */
export function registerCursorCliShutdownSafety(
	pi: Pick<ExtensionAPI, "on">,
	deps: CursorCliShutdownSafetyDeps = {},
): CursorCliGenerationGuard {
	const generation = deps.generation ?? new CursorCliGenerationGuard();
	const registry = deps.registry ?? cursorCliChildRegistry;
	const teardown = (reason: string): void => {
		registry.killAll();
		generation.clearTrackedTimers();
		generation.retire(reason);
	};
	pi.on("session_shutdown", (event: SessionShutdownEvent) => {
		teardown(event.reason);
	});
	pi.on("session_extensions_removed", (event: SessionExtensionsRemovedEvent) => {
		teardown(event.reason);
	});
	return generation;
}
