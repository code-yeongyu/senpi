import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { bindToProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.ts";
import { resolvePath } from "../../../../utils/paths.ts";
import { ModelConfig } from "../../../model-config.ts";
import { parseSettingsJson, type Settings, SettingsManager, wasSelfWrite } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../types.ts";
import { type ActiveTarget, groupChangedPaths } from "./change-groups.ts";
import { isLoadableExtensionEntry, isScannableExtensionDirectory } from "./extension-watch-scope.ts";
import { excludeGeneratedExtensionShims } from "./generated-shim-filter.ts";
import { type ConfigReloadLogger, createConfigReloadLogger } from "./log.ts";
import {
	CONFIG_WATCH_CHANGED,
	CONFIG_WATCH_READY,
	CONFIG_WATCH_REGISTER,
	CONFIG_WATCH_REJECTED,
	CONFIG_WATCH_RELOADED,
	CONFIG_WATCH_UNREGISTER,
	type ConfigWatchRegistration,
	type ConfigWatchTarget,
	isConfigWatchRegistration,
	isConfigWatchUnregistration,
	isConfigWatchValidation,
	matchesConfigWatchFilter,
} from "./protocol.ts";
import { ReloadVetoDeferral } from "./reload-deferral.ts";
import {
	excludeRoutineOnlySettingsChanges,
	isSettingsPath,
	joinConfigDir,
	refreshSettingsContentSnapshots,
	updateSettingsContentSnapshot,
} from "./routine-settings.ts";
import { bindSessionScopedCallback } from "./session-scoped-callback.ts";
import {
	ConfigReloadWatchEngine,
	createFsWatchEventSource,
	type RealChange,
	type WatchClock,
	type WatchEventSource,
	type WatchTarget,
} from "./watch-engine.ts";

const BUILTIN_REGISTRATION_ID = "builtin";
export const DEFAULT_DEBOUNCE_MS = 200;
const COMPACTION_RECHECK_MS = 250;
const VETO_RECHECK_MS = 1000;
// After the first few 1 s rechecks a still-vetoed reload (e.g. long-running subagents) backs off;
// agent_end/agent_settled still flush it immediately when the session goes idle.
const VETO_RECHECK_FAST_ATTEMPTS = 5;
const VETO_RECHECK_MAX_MS = 30_000;
// A reload that only ever re-triggers itself from the post-reload comparison stops here (#2878).
const MAX_HANDOFF_RELOADS = 3;
const CONFIG_FILE_NAMES = ["settings.jsonc", "settings.json", "models.json", "keybindings.json"] as const;

/**
 * The engine applies one predicate to both file gating and directory descent, so
 * this must admit scannable directories in order to reach their entry files.
 */
const extensionWatchFilter =
	(extensionsDir: string) =>
	(relPath: string): boolean =>
		isLoadableExtensionEntry(extensionsDir, relPath) || isScannableExtensionDirectory(extensionsDir, relPath);

type ConfigReloadWatchSettings = {
	readonly settings?: boolean;
	readonly models?: boolean;
	readonly keybindings?: boolean;
	readonly prompts?: boolean;
	readonly skills?: boolean;
	readonly extensions?: boolean;
};

type ConfigReloadSettingsPatch = {
	readonly enabled?: boolean;
	readonly debounceMs?: number;
	readonly watch?: ConfigReloadWatchSettings;
};

/** Keep config-reload's settings schema owned by the builtin while exposing it on Settings. */
declare module "../../../settings-manager.ts" {
	interface Settings {
		configReload?: ConfigReloadSettingsPatch;
	}
}

type ResolvedConfigReloadSettings = {
	readonly enabled: boolean;
	readonly debounceMs: number;
	readonly watch: Required<ConfigReloadWatchSettings>;
};

type WatchTargetInput = Omit<WatchTarget, "id">;

type PendingChange = {
	readonly registrationId: string;
	readonly paths: Set<string>;
};

type HandoffChain = {
	/** Consecutive reloads requested only by a post-reload comparison; 0 for a watcher-detected change. */
	readonly count: number;
};

type ReloadHandoff = {
	readonly chain: HandoffChain;
	readonly hashesAtRequest: ReadonlyMap<string, string>;
	readonly settingsContentsAtRequest: ReadonlyMap<string, string>;
	readonly requestedAt: number;
	readonly changes: readonly { readonly registrationId: string; readonly paths: readonly string[] }[];
};

/** Session-keyed handoffs survive replacement extension factories during reload. */
export class ConfigReloadHandoffRegistry<T> {
	readonly #handoffs = new Map<string, T>();

	set(sessionHandle: string, handoff: T): void {
		this.#handoffs.set(sessionHandle, handoff);
	}

	take(sessionHandle: string): T | undefined {
		const handoff = this.#handoffs.get(sessionHandle);
		this.#handoffs.delete(sessionHandle);
		return handoff;
	}

	delete(sessionHandle: string): void {
		this.#handoffs.delete(sessionHandle);
	}
}

const reloadHandoffs = new ConfigReloadHandoffRegistry<ReloadHandoff>();

export interface ConfigReloadExtensionOptions {
	readonly agentDir?: string;
	readonly subscribe?: WatchEventSource;
	readonly clock?: WatchClock;
	readonly logger?: ConfigReloadLogger;
	/** Test seam. Production uses the watch engine's SHA-256 implementation. */
	readonly hashFile?: (path: string) => string;
}

/**
 * Watch config resources and request the host's existing full reload flow.
 *
 * The optional options are test seams. Production registration uses the default
 * filesystem event source and agent directory.
 */
export function configReloadExtension(pi: ExtensionAPI, options: ConfigReloadExtensionOptions = {}): void {
	const sessionOwned = (() => {
		try {
			bindToProviderScope(() => undefined);
			return true;
		} catch {
			return false;
		}
	})();
	const handoffKey = (ctx: ExtensionContext): string => (sessionOwned ? ctx.sessionManager.getSessionId() : "classic");
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const subscribe = options.subscribe ?? createFsWatchEventSource();
	const logger = options.logger ?? createConfigReloadLogger(agentDir);
	const registrations = new Map<string, ConfigWatchRegistration>();
	const rejectedRegistrations = new Map<string, string>();
	/** Last-seen settings.json contents per path; the diff base for routine-key classification. */
	const settingsContents = new Map<string, string>();
	const eventUnsubscribes: Array<() => void> = [];
	const pending = new Map<string, PendingChange>();
	let engine: ConfigReloadWatchEngine | undefined;
	let activeTargets: ActiveTarget[] = [];
	let currentContext: ExtensionContext | undefined;
	let started = false;
	const watcherClosures: Array<Promise<PromiseSettledResult<void>[]>> = [];
	let reloadInFlight = false;
	let deferredNoticeShown = false;
	let unavailableReloadLogged = false;
	let compactionRecheck: ReturnType<typeof setTimeout> | undefined;
	let vetoRecheck: ReturnType<typeof setTimeout> | undefined;
	let vetoRecheckAttempts = 0;
	const vetoDeferral = new ReloadVetoDeferral();
	let nextReloadChain: HandoffChain | undefined;
	/** Handoff paths an extension watched before the reload and has not re-registered yet. */
	const awaitingRegistration = new Map<string, string>();
	let awaitingHandoff: ReloadHandoff | undefined;
	let changeChain: Promise<void> = Promise.resolve();

	// Cancel registrations synchronously; session_shutdown joins every disposer.
	const closeWatchers = (): void => {
		if (!engine) return;
		watcherClosures.push(Promise.allSettled([engine.close()]));
		engine = undefined;
		activeTargets = [];
	};

	const clearCompactionRecheck = (): void => {
		if (compactionRecheck === undefined) return;
		(options.clock ?? defaultClock).clearTimeout(compactionRecheck);
		compactionRecheck = undefined;
	};

	const clearVetoRecheck = (): void => {
		if (vetoRecheck === undefined) return;
		(options.clock ?? defaultClock).clearTimeout(vetoRecheck);
		vetoRecheck = undefined;
	};

	const cleanupEventListeners = (): void => {
		for (const unsubscribe of eventUnsubscribes.splice(0)) {
			unsubscribe();
		}
	};

	const rejectRegistration = (registrationId: string, errors: readonly string[]): void => {
		pi.events.emit(CONFIG_WATCH_REJECTED, {
			registrationId,
			paths: [],
			errors: [...errors],
		});
		logger.warn("registration_rejected", { registrationId, errorCount: errors.length });
	};

	const handleRegistration = (payload: unknown): void => {
		if (!isConfigWatchRegistration(payload)) return;
		const fingerprint = registrationFingerprint(payload);
		// A component may synchronously re-register from a CONFIG_WATCH_REJECTED
		// listener (e.g. sticky-rejection recovery). Rejected registrations are
		// never stored, so the identity guard below cannot break that recursion;
		// ignoring an identical payload after one rejection does.
		if (rejectedRegistrations.get(payload.id) === fingerprint) {
			logger.debug("registration_rejection_suppressed", { registrationId: payload.id });
			return;
		}
		const cwd = currentContext?.cwd ?? process.cwd();
		if (registrationHasRestrictedTarget(payload, cwd, agentDir)) {
			rejectedRegistrations.set(payload.id, fingerprint);
			rejectRegistration(payload.id, ["Configuration watch target is restricted"]);
			return;
		}
		rejectedRegistrations.delete(payload.id);

		// A component may re-emit its unchanged registration when it receives the
		// ready event from rebuildWatchers. Rebuilding for that same payload emits
		// ready again and creates an unbounded synchronous rebuild loop.
		if (registrations.get(payload.id) === payload) return;
		registrations.set(payload.id, payload);
		pending.delete(payload.id);
		logger.info("registration_added", { id: payload.id });
		if (started && currentContext) {
			rebuildWatchers(currentContext);
			settleAwaitingRegistration(currentContext);
		}
	};

	const handleUnregistration = (payload: unknown): void => {
		if (!isConfigWatchUnregistration(payload)) return;
		rejectedRegistrations.delete(payload.id);
		if (!registrations.delete(payload.id)) return;
		pending.delete(payload.id);
		logger.info("registration_removed", { id: payload.id });
		if (started && currentContext) {
			rebuildWatchers(currentContext);
		}
	};

	const processChange = async (change: RealChange): Promise<void> => {
		if (reloadInFlight || !currentContext || !started) return;
		const changeContext = currentContext;
		// Suppression state (self-write consumption, routine-diff base) is per path,
		// so it must be resolved before grouping: a path watched by several
		// registrations would otherwise be classified once per group and reach the
		// reload flow through the later group.
		const suppress = (paths: readonly string[], context: ExtensionContext): string[] => {
			const watchedPaths = excludeSelfWrites(paths, engine, agentDir, context.cwd, logger, settingsContents);
			const significantPaths = excludeRoutineOnlySettingsChanges(
				watchedPaths,
				settingsContents,
				agentDir,
				context.cwd,
				logger,
			);
			const kept = excludeGeneratedExtensionShims(significantPaths, agentDir);
			for (const path of significantPaths) {
				if (!kept.includes(path)) logger.debug("generated_shim_change_suppressed", { path });
			}
			return kept;
		};
		const configPaths = suppress(change.changedPaths, currentContext);
		// Rebuilding recomputes the targets, so record which created paths were presence containers first.
		const rearmedContainers = change.created
			.map((path) => resolve(path))
			.filter((path) => activeTargets.some((target) => target.rearmOnCreation === path));
		if (rearmedContainers.length > 0) {
			const previous = engine?.getBaselineSnapshot() ?? new Map<string, string>();
			rebuildWatchers(currentContext);
			const current = engine?.getBaselineSnapshot() ?? new Map<string, string>();
			// Files discovered by the rearm pass through the same self-write, routine and shim filters.
			configPaths.push(...suppress(compareSnapshots(previous, current), currentContext));
		}
		const groups = groupChangedPaths(configPaths, activeTargets, rearmedContainers);
		for (const [registrationId, paths] of groups) {
			const errors = await validateChangedPaths(registrationId, paths, registrations, agentDir, currentContext.cwd);
			if (!started || currentContext !== changeContext) return;
			if (errors.length > 0) {
				rejectChange(currentContext, registrationId, paths, errors, logger, pi);
				continue;
			}

			addPending(pending, registrationId, paths);
			const deferred = !canRequestReload(currentContext);
			pi.events.emit(CONFIG_WATCH_CHANGED, {
				registrationId,
				paths: [...paths],
				deferred,
			});
			logger.info("change_detected", { registrationId, paths, deferred });
		}
		await flushPending();
	};

	const enqueueChange = (change: RealChange): void => {
		if (reloadInFlight) return;
		changeChain = changeChain
			.then(() => processChange(change))
			.catch((error: unknown) => {
				logger.error("watcher_error", { path: "config reload", message: errorMessage(error) });
			});
	};

	const rebuildWatchers = (ctx: ExtensionContext): void => {
		if (!started || currentContext !== ctx) return;
		closeWatchers();
		clearCompactionRecheck();
		const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
		const settings = resolveConfigReloadSettings(settingsManager);
		// Nonpersistent RPC probes need a configuration snapshot, not live OS watches.
		if (
			!settings.enabled ||
			ctx.mode === "print" ||
			ctx.mode === "json" ||
			(ctx.mode === "rpc" && ctx.sessionManager.getSessionFile() === undefined)
		) {
			pi.events.emit(CONFIG_WATCH_READY, { enabled: false });
			return;
		}

		activeTargets = buildWatchTargets({
			cwd: ctx.cwd,
			agentDir,
			projectTrusted: ctx.isProjectTrusted(),
			settings,
			skillPaths: settings.watch.skills ? settingsManager.getSkillPaths() : [],
			registrations,
		});
		engine = new ConfigReloadWatchEngine({
			targets: activeTargets.map((entry) => entry.target),
			subscribe,
			debounceMs: settings.debounceMs,
			clock: options.clock,
			hashFile: options.hashFile,
			onRealChange: bindSessionScopedCallback((change: RealChange) => {
				nextReloadChain = undefined;
				enqueueChange(change);
			}),
			onError: bindSessionScopedCallback((error, path) => {
				logger.error("watcher_error", { path, message: errorMessage(error) });
			}),
		});
		refreshSettingsContentSnapshots(settingsContents, agentDir, ctx.cwd);
		logger.info("watcher_started", { targetCount: activeTargets.length });
		pi.events.emit(CONFIG_WATCH_READY, { enabled: true });
	};

	const flushPending = async (): Promise<void> => {
		const ctx = currentContext;
		if (!ctx || pending.size === 0 || reloadInFlight) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (ctx.isCompacting?.() ?? false) {
			armCompactionRecheck();
			return;
		}
		clearCompactionRecheck();
		if (!ctx.requestReload) {
			if (!unavailableReloadLogged) {
				unavailableReloadLogged = true;
				logger.info("reload_requested", { reason: "requestReload unavailable", paths: [] });
			}
			return;
		}

		// Probe the extension veto (session_before_reload) BEFORE announcing the
		// reload: a vetoed hot-reload defers quietly (one notice per distinct
		// reason) and retries on later idle edges or the veto recheck clock,
		// instead of re-notifying "Hot-reloading:" plus the veto warning forever.
		if (ctx.checkReloadVeto) {
			const veto = await ctx.checkReloadVeto();
			if (currentContext !== ctx || reloadInFlight || pending.size === 0 || !canRequestReload(ctx)) return;
			if (veto.cancelled) {
				const notice = vetoDeferral.defer(veto.reason);
				if (notice) {
					ctx.ui.notify(notice, "info");
					logger.info("reload_deferred", { reason: veto.reason ?? "extension veto" });
				}
				armVetoRecheck();
				return;
			}
		}
		clearVetoRecheck();
		vetoRecheckAttempts = 0;
		vetoDeferral.reset();

		const changes = pendingChanges(pending);
		const paths = uniquePaths(changes.flatMap((change) => change.paths));
		reloadInFlight = true;
		reloadHandoffs.set(handoffKey(ctx), {
			chain: nextReloadChain ?? { count: 0 },
			hashesAtRequest: engine?.getBaselineSnapshot() ?? new Map<string, string>(),
			settingsContentsAtRequest: new Map(settingsContents),
			requestedAt: Date.now(),
			changes,
		});
		nextReloadChain = undefined;
		ctx.ui.notify(`Hot-reloading: ${formatPaths(paths)}`, "info");
		logger.info("reload_requested", { reason: "config changed", paths });

		const handoffKeyForReload = handoffKey(ctx);
		try {
			await ctx.requestReload();
			reloadInFlight = false;
			reloadHandoffs.delete(handoffKeyForReload);
		} catch (error) {
			reloadInFlight = false;
			reloadHandoffs.delete(handoffKeyForReload);
			logger.error("watcher_error", { path: "reload", message: errorMessage(error) });
		}
	};

	const armCompactionRecheck = (): void => {
		if (compactionRecheck !== undefined) return;
		const clock = options.clock ?? defaultClock;
		compactionRecheck = clock.setTimeout(() => {
			compactionRecheck = undefined;
			void flushPending();
		}, COMPACTION_RECHECK_MS);
	};

	const armVetoRecheck = (): void => {
		if (vetoRecheck !== undefined) return;
		const clock = options.clock ?? defaultClock;
		const backoffStep = vetoRecheckAttempts - VETO_RECHECK_FAST_ATTEMPTS + 1;
		const delay =
			backoffStep <= 0 ? VETO_RECHECK_MS : Math.min(VETO_RECHECK_MAX_MS, VETO_RECHECK_MS * 2 ** backoffStep);
		vetoRecheckAttempts++;
		vetoRecheck = clock.setTimeout(() => {
			vetoRecheck = undefined;
			void flushPending();
		}, delay);
	};

	/**
	 * Queue a change the post-reload comparison found. A comparison-only chain (each reload
	 * triggered solely by the previous reload's comparison) stops after MAX_HANDOFF_RELOADS
	 * consecutive reloads however slow each one is, so a path that always looks changed cannot loop forever.
	 */
	const enqueueHandoffChange = async (
		handoff: ReloadHandoff,
		changedPaths: readonly string[],
		ctx: ExtensionContext,
	): Promise<void> => {
		if (changedPaths.length === 0) return;
		const chain: HandoffChain = { count: handoff.chain.count + 1 };
		if (chain.count > MAX_HANDOFF_RELOADS) {
			logger.warn("reload_loop_stopped", { paths: changedPaths, reloads: handoff.chain.count });
			ctx.ui.notify(
				`Hot-reload stopped: ${formatPaths(changedPaths)} still looked changed after ${handoff.chain.count} reloads in a row. Edit the file again or run /reload to retry.`,
				"warning",
			);
			return;
		}
		settingsContents.clear();
		for (const [path, content] of handoff.settingsContentsAtRequest) settingsContents.set(path, content);
		nextReloadChain = chain;
		enqueueChange({ changedPaths: [...changedPaths], created: [], deleted: [] });
		await changeChain;
	};

	/** Compare handoff paths whose extension re-registered them after session_start (#2878). */
	const settleAwaitingRegistration = (ctx: ExtensionContext): void => {
		const handoff = awaitingHandoff;
		if (!handoff || awaitingRegistration.size === 0) return;
		const current = engine?.getBaselineSnapshot() ?? new Map<string, string>();
		const changed: string[] = [];
		for (const [path, hash] of awaitingRegistration) {
			if (!current.has(path)) continue;
			awaitingRegistration.delete(path);
			if (current.get(path) !== hash) changed.push(path);
		}
		if (awaitingRegistration.size === 0) awaitingHandoff = undefined;
		void enqueueHandoffChange(handoff, changed.sort(), ctx);
	};

	const processReloadHandoff = async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
		if (event.reason !== "reload") return;
		const handoff = reloadHandoffs.take(handoffKey(ctx));
		if (!handoff) return;
		const paths = uniquePaths(handoff.changes.flatMap((change) => change.paths));
		for (const change of handoff.changes) {
			pi.events.emit(CONFIG_WATCH_RELOADED, {
				registrationId: change.registrationId,
				paths: [...change.paths],
			});
		}
		ctx.ui.notify(`Hot-reloaded: ${formatPaths(paths)}`, "info");
		logger.info("reload_completed", { durationMs: Math.max(0, Date.now() - handoff.requestedAt) });

		// Extensions re-register their watch targets after this session_start handler, so a path
		// missing from the new baseline but still on disk is awaited, not reported as changed (#2878).
		const { changed, awaiting } = compareHandoffSnapshots(
			handoff.hashesAtRequest,
			engine?.getBaselineSnapshot() ?? new Map(),
		);
		for (const [path, hash] of awaiting) awaitingRegistration.set(path, hash);
		awaitingHandoff = awaiting.size > 0 ? handoff : undefined;
		await enqueueHandoffChange(handoff, changed, ctx);
	};

	eventUnsubscribes.push(pi.events.on(CONFIG_WATCH_REGISTER, handleRegistration));
	eventUnsubscribes.push(pi.events.on(CONFIG_WATCH_UNREGISTER, handleUnregistration));

	pi.on("session_start", async (event, ctx) => {
		started = true;
		currentContext = ctx;
		awaitingRegistration.clear();
		awaitingHandoff = undefined;
		rebuildWatchers(ctx);
		await processReloadHandoff(event, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!started) return;
		currentContext = ctx;
		await flushPending();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!started) return;
		currentContext = ctx;
		await flushPending();
	});
	pi.on("project_trust", () => {
		if (currentContext) rebuildWatchers(currentContext);
		return { trusted: "undecided" };
	});
	pi.on("session_shutdown", async (event) => {
		const closingContext = currentContext;
		started = false;
		currentContext = undefined;
		closeWatchers();
		clearCompactionRecheck();
		clearVetoRecheck();
		vetoRecheckAttempts = 0;
		vetoDeferral.reset();
		cleanupEventListeners();
		pending.clear();
		awaitingRegistration.clear();
		awaitingHandoff = undefined;
		nextReloadChain = undefined;
		if (event.reason !== "reload" && closingContext) reloadHandoffs.delete(handoffKey(closingContext));
		const results = (await Promise.all(watcherClosures.splice(0))).flat();
		const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
		if (errors.length > 0) throw new AggregateError(errors, "Config watcher shutdown failed");
	});

	function canRequestReload(ctx: ExtensionContext): boolean {
		return (
			ctx.isIdle() &&
			!ctx.hasPendingMessages() &&
			!(ctx.isCompacting?.() ?? false) &&
			ctx.requestReload !== undefined
		);
	}

	function armDeferredNotice(ctx: ExtensionContext): void {
		if (deferredNoticeShown || pending.size === 0 || !ctx.requestReload) return;
		deferredNoticeShown = true;
		ctx.ui.notify("Config changed; reloading when idle", "info");
	}

	function rejectChange(
		ctx: ExtensionContext,
		registrationId: string,
		paths: readonly string[],
		errors: readonly string[],
		activeLogger: ConfigReloadLogger,
		api: ExtensionAPI,
	): void {
		ctx.ui.notify(`Config change rejected: ${errors.join("; ")}`, "error");
		api.events.emit(CONFIG_WATCH_REJECTED, { registrationId, paths: [...paths], errors: [...errors] });
		activeLogger.warn("validation_rejected", { registrationId, errorCount: errors.length });
	}

	function addPending(changes: Map<string, PendingChange>, registrationId: string, paths: readonly string[]): void {
		const pendingChange = changes.get(registrationId) ?? { registrationId, paths: new Set<string>() };
		for (const path of paths) pendingChange.paths.add(path);
		changes.set(registrationId, pendingChange);
		if (!canRequestReload(currentContext!)) armDeferredNotice(currentContext!);
	}
}

export default configReloadExtension;

const defaultClock: WatchClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer),
};

function resolveConfigReloadSettings(settingsManager: SettingsManager): ResolvedConfigReloadSettings {
	const global = readConfigReloadPatch(settingsManager.getGlobalSettings());
	const project = readConfigReloadPatch(settingsManager.getProjectSettings());
	return {
		enabled: project.enabled ?? global.enabled ?? true,
		debounceMs: project.debounceMs ?? global.debounceMs ?? DEFAULT_DEBOUNCE_MS,
		watch: {
			settings: project.watch?.settings ?? global.watch?.settings ?? true,
			models: project.watch?.models ?? global.watch?.models ?? true,
			keybindings: project.watch?.keybindings ?? global.watch?.keybindings ?? true,
			prompts: project.watch?.prompts ?? global.watch?.prompts ?? true,
			skills: project.watch?.skills ?? global.watch?.skills ?? true,
			extensions: project.watch?.extensions ?? global.watch?.extensions ?? true,
		},
	};
}

function readConfigReloadPatch(settings: Settings): ConfigReloadSettingsPatch {
	const candidate: unknown = settings.configReload;
	if (!isPlainObject(candidate)) return {};
	const watch = isPlainObject(candidate.watch) ? candidate.watch : undefined;
	return {
		enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : undefined,
		debounceMs: validDebounce(candidate.debounceMs),
		watch: watch
			? {
					settings: booleanOrUndefined(watch.settings),
					models: booleanOrUndefined(watch.models),
					keybindings: booleanOrUndefined(watch.keybindings),
					prompts: booleanOrUndefined(watch.prompts),
					skills: booleanOrUndefined(watch.skills),
					extensions: booleanOrUndefined(watch.extensions),
				}
			: undefined,
	};
}

function validDebounce(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

function booleanOrUndefined(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function buildWatchTargets(options: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
	readonly settings: ResolvedConfigReloadSettings;
	readonly skillPaths: readonly string[];
	readonly registrations: ReadonlyMap<string, ConfigWatchRegistration>;
}): ActiveTarget[] {
	const targets: ActiveTarget[] = [];
	const addBuiltin = (id: string, target: WatchTargetInput, rearmOnCreation?: string): void => {
		targets.push({ registrationId: BUILTIN_REGISTRATION_ID, target: { ...target, id }, rearmOnCreation });
	};
	const addBuiltinDirectory = (id: string, path: string, filter?: (relPath: string) => boolean): void => {
		const resourcePath = resolve(path);
		if (isExistingDirectory(resourcePath)) {
			addBuiltin(
				id,
				filter
					? { kind: "dir-recursive", path: resourcePath, filter }
					: { kind: "dir-recursive", path: resourcePath },
			);
			return;
		}
		const watchPath = nearestExistingDirectory(dirname(resourcePath));
		const firstMissingSegment = relative(watchPath, resourcePath).split(sep)[0] || basename(resourcePath);
		const createdPath = resolve(watchPath, firstMissingSegment);
		addBuiltin(
			`${id}-presence`,
			{
				kind: "dir",
				path: watchPath,
				allowList: [firstMissingSegment],
			},
			createdPath,
		);
	};
	const { cwd, agentDir, projectTrusted, settings } = options;
	const projectDir = joinConfigDir(cwd);

	const jsonAllowList = CONFIG_FILE_NAMES.filter((name) => {
		if (name === "settings.json" || name === "settings.jsonc") return settings.watch.settings;
		if (name === "models.json") return settings.watch.models;
		return settings.watch.keybindings;
	});
	if (jsonAllowList.length > 0) {
		addBuiltin("builtin-global-json", { kind: "dir", path: agentDir, allowList: jsonAllowList });
	}
	if (settings.watch.prompts) {
		addBuiltinDirectory("builtin-global-prompts", resolve(agentDir, "prompts"));
	}
	if (settings.watch.extensions) {
		const globalExtensionsDir = resolve(agentDir, "extensions");
		addBuiltinDirectory("builtin-global-extensions", globalExtensionsDir, extensionWatchFilter(globalExtensionsDir));
	}
	if (settings.watch.skills) {
		for (const [index, skillPath] of options.skillPaths.entries()) {
			const target = targetForSkillPath(resolvePath(skillPath, cwd, { trim: true }));
			if (target.kind === "dir-recursive") {
				addBuiltinDirectory(`builtin-skill-${index}`, target.path);
			} else {
				addBuiltin(`builtin-skill-${index}`, target);
			}
		}
	}

	if (projectTrusted) {
		const projectDirExists = isExistingDirectory(projectDir);
		const projectWatchEnabled = Object.values(settings.watch).some(Boolean);
		if (projectWatchEnabled) {
			addBuiltin(
				"builtin-project-presence",
				{ kind: "dir", path: cwd, allowList: [CONFIG_DIR_NAME] },
				projectDirExists ? undefined : projectDir,
			);
		}
		if (projectDirExists) {
			if (settings.watch.settings) {
				addBuiltin("builtin-project-settings", {
					kind: "dir",
					path: projectDir,
					allowList: ["settings.jsonc", "settings.json"],
				});
			}
			if (settings.watch.prompts) {
				addBuiltinDirectory("builtin-project-prompts", resolve(projectDir, "prompts"));
			}
			if (settings.watch.skills) {
				addBuiltinDirectory("builtin-project-skills", resolve(projectDir, "skills"));
			}
			if (settings.watch.extensions) {
				const projectExtensionsDir = resolve(projectDir, "extensions");
				addBuiltinDirectory(
					"builtin-project-extensions",
					projectExtensionsDir,
					extensionWatchFilter(projectExtensionsDir),
				);
			}
		}
	}

	for (const registration of options.registrations.values()) {
		for (const [index, target] of registration.targets.entries()) {
			const path = resolvePath(target.path, cwd, { trim: true });
			const watchTarget = externalTargetToWatchTarget(path, target.kind, target.filterGlobs);
			targets.push({
				registrationId: registration.id,
				target: { ...watchTarget, id: `external-${registration.id}-${index}` },
			});
		}
	}
	return targets;
}

function isExistingDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function nearestExistingDirectory(path: string): string {
	let candidate = resolve(path);
	while (!isExistingDirectory(candidate)) {
		const parent = dirname(candidate);
		if (parent === candidate) return candidate;
		candidate = parent;
	}
	return candidate;
}

function targetForSkillPath(path: string): WatchTargetInput {
	try {
		if (lstatSync(path).isFile()) {
			return { kind: "dir", path: dirname(path), allowList: [basename(path)] };
		}
	} catch {
		// A missing configured skill path is treated as a directory so it becomes watchable when present.
	}
	return { kind: "dir-recursive", path };
}

function externalTargetToWatchTarget(
	path: string,
	kind: "file" | "dir",
	filterGlobs: readonly string[] | undefined,
): WatchTargetInput {
	if (kind === "file") {
		const name = basename(path);
		return {
			kind: "dir",
			path: dirname(path),
			allowList: [name],
			filter: (relativePath) => relativePath === name && matchesConfigWatchFilter(relativePath, filterGlobs),
		};
	}
	return {
		kind: "dir-recursive",
		path,
		// Literal filters also declare explicitly watched dot-directories. Without
		// this, an external ancestor target filtered to ".omo" drops its creation
		// event before the validator can inspect the new config beneath it.
		allowList: literalFilterNames(filterGlobs),
		filter: (relativePath) => matchesConfigWatchFilter(relativePath, filterGlobs),
	};
}

function literalFilterNames(filterGlobs: readonly string[] | undefined): string[] | undefined {
	if (!filterGlobs) return undefined;
	// A root-anchored glob names a literal path relative to the watch root, so
	// strip the anchor before the separator check rejects it.
	const literalNames = filterGlobs
		.map((filterGlob) => (filterGlob.startsWith("/") ? filterGlob.slice(1) : filterGlob))
		.filter((filterGlob) => !filterGlob.includes("*") && !filterGlob.includes("/") && !filterGlob.includes("\\\\"));
	return literalNames.length > 0 ? literalNames : undefined;
}

function excludeSelfWrites(
	paths: readonly string[],
	engine: ConfigReloadWatchEngine | undefined,
	agentDir: string,
	cwd: string,
	logger: ConfigReloadLogger,
	settingsContents: Map<string, string>,
): string[] {
	const snapshot = engine?.getBaselineSnapshot();
	return paths.filter((path) => {
		if (!isSettingsPath(path, agentDir, cwd)) return true;
		const hash = snapshot?.get(path);
		if (hash === undefined || !wasSelfWrite(path, hash)) return true;
		logger.debug("self_write_suppressed", { path });
		// Advance the routine-diff base so a later external change is not
		// polluted by this session's own just-applied write.
		updateSettingsContentSnapshot(settingsContents, path);
		return false;
	});
}

async function validateChangedPaths(
	registrationId: string,
	paths: readonly string[],
	registrations: ReadonlyMap<string, ConfigWatchRegistration>,
	agentDir: string,
	cwd: string,
): Promise<string[]> {
	if (registrationId === BUILTIN_REGISTRATION_ID) {
		return validateBuiltinPaths(paths, agentDir, cwd);
	}
	const registration = registrations.get(registrationId);
	if (!registration?.validate) return [];
	try {
		const result = await registration.validate(paths);
		if (!isConfigWatchValidation(result)) return ["Configuration validator returned an invalid result"];
		return result.ok ? [] : result.errors;
	} catch (error) {
		return [errorMessage(error)];
	}
}

function validateBuiltinPaths(paths: readonly string[], agentDir: string, cwd: string): string[] {
	const errors: string[] = [];
	for (const path of paths) {
		if (isSettingsPath(path, agentDir, cwd)) {
			const error = validateSettingsFile(path);
			if (error) errors.push(error);
			continue;
		}
		if (resolve(path) === resolve(agentDir, "models.json")) {
			const error = ModelConfig.loadSync(path).getError();
			if (error) errors.push(error);
			continue;
		}
		if (resolve(path) === resolve(agentDir, "keybindings.json")) {
			const error = validateKeybindingsFile(path);
			if (error) errors.push(error);
		}
	}
	return errors;
}

function validateSettingsFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = parseSettingsJson(readFileSync(path, "utf-8"));
		// Keep validation aligned with SettingsManager's loader and migrations without duplicating migration rules.
		SettingsManager.inMemory(parsed as Partial<Settings>);
		return undefined;
	} catch (error) {
		return `Invalid ${basename(path)}: ${errorMessage(error)}`;
	}
}

function validateKeybindingsFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isPlainObject(parsed)) return "keybindings.json must contain an object";
		for (const value of Object.values(parsed)) {
			if (typeof value === "string") continue;
			if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) continue;
			return "keybindings.json bindings must be strings or string arrays";
		}
		return undefined;
	} catch (error) {
		return `Invalid keybindings.json: ${errorMessage(error)}`;
	}
}

function registrationFingerprint(registration: ConfigWatchRegistration): string {
	return JSON.stringify({
		id: registration.id,
		displayName: registration.displayName,
		targets: registration.targets.map((target) => ({
			path: target.path,
			kind: target.kind,
			filterGlobs: target.filterGlobs ?? null,
		})),
		hasValidate: registration.validate !== undefined,
	});
}

// A directory target that covers a protected path is safe when every filter is
// root-anchored (a leading `/` matches only a path relative to the watch root,
// never a suffix at any depth) and none of those anchored paths intersects a
// protected path in either direction. Unfiltered targets, unanchored filters,
// and any protected filter stay fail-closed.
function isSafeFilteredProtectedTarget(
	target: ConfigWatchTarget,
	resolvedPath: string,
	protectedPaths: readonly string[],
): boolean {
	if (target.kind !== "dir") return false;
	if (protectedPaths.some((protectedPath) => isWithin(resolvedPath, protectedPath))) return false;
	const filterGlobs = target.filterGlobs;
	if (!filterGlobs || filterGlobs.length === 0) return false;
	return filterGlobs.every((glob) => {
		if (!glob.startsWith("/")) return false;
		const filteredPath = resolve(resolvedPath, glob.slice(1));
		return protectedPaths.every(
			(protectedPath) => !isWithin(filteredPath, protectedPath) && !isWithin(protectedPath, filteredPath),
		);
	});
}

function registrationHasRestrictedTarget(
	registration: ConfigWatchRegistration,
	cwd: string,
	agentDir: string,
): boolean {
	const protectedPaths = [resolve(agentDir, "auth.json"), resolve(agentDir, "sessions"), resolve(agentDir, "logs")];
	return registration.targets.some((target) => {
		const path = resolvePath(target.path, cwd, { trim: true });
		if (isSafeFilteredProtectedTarget(target, path, protectedPaths)) return false;
		return protectedPaths.some((protectedPath) => isWithin(path, protectedPath) || isWithin(protectedPath, path));
	});
}

function pendingChanges(pending: ReadonlyMap<string, PendingChange>): Array<{
	readonly registrationId: string;
	readonly paths: readonly string[];
}> {
	return [...pending.values()].map((change) => ({
		registrationId: change.registrationId,
		paths: [...change.paths].sort(),
	}));
}

function compareHandoffSnapshots(
	previousHashes: ReadonlyMap<string, string>,
	next: ReadonlyMap<string, string>,
): { readonly changed: string[]; readonly awaiting: ReadonlyMap<string, string> } {
	const changed = new Set<string>();
	const awaiting = new Map<string, string>();
	for (const [path, hash] of next) {
		if (previousHashes.get(path) !== hash) changed.add(path);
	}
	for (const [path, hash] of previousHashes) {
		if (next.has(path)) continue;
		if (existsSync(path)) awaiting.set(path, hash);
		else changed.add(path);
	}
	return { changed: [...changed].sort(), awaiting };
}

function compareSnapshots(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string[] {
	const changed = new Set<string>();
	for (const [path, hash] of next) {
		if (previous.get(path) !== hash) changed.add(path);
	}
	for (const path of previous.keys()) {
		if (!next.has(path)) changed.add(path);
	}
	return [...changed].sort();
}

function uniquePaths(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort();
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatPaths(paths: readonly string[]): string {
	return paths.length === 0 ? "configuration" : paths.join(", ");
}
