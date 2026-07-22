import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.ts";
import { resolvePath } from "../../../../utils/paths.ts";
import { ModelConfig } from "../../../model-config.ts";
import { type Settings, SettingsManager, wasSelfWrite } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../types.ts";
import { type ConfigReloadLogger, createConfigReloadLogger } from "./log.ts";
import {
	CONFIG_WATCH_CHANGED,
	CONFIG_WATCH_READY,
	CONFIG_WATCH_REGISTER,
	CONFIG_WATCH_REJECTED,
	CONFIG_WATCH_RELOADED,
	CONFIG_WATCH_UNREGISTER,
	type ConfigWatchRegistration,
	isConfigWatchRegistration,
	isConfigWatchUnregistration,
	isConfigWatchValidation,
	matchesConfigWatchFilter,
} from "./protocol.ts";
import {
	ConfigReloadWatchEngine,
	createFsWatchEventSource,
	type RealChange,
	type WatchClock,
	type WatchEventSource,
	type WatchTarget,
} from "./watch-engine.ts";

const BUILTIN_REGISTRATION_ID = "builtin";
const DEFAULT_DEBOUNCE_MS = 200;
const COMPACTION_RECHECK_MS = 250;
const CONFIG_FILE_NAMES = ["settings.json", "models.json", "keybindings.json"] as const;

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

type ActiveTarget = {
	readonly registrationId: string;
	readonly target: WatchTarget;
	/** Presence targets rebuild the watcher set once this missing path appears. */
	readonly rearmOnCreation?: string;
};

type PendingChange = {
	readonly registrationId: string;
	readonly paths: Set<string>;
};

type ReloadHandoff = {
	readonly hashesAtRequest: ReadonlyMap<string, string>;
	readonly requestedAt: number;
	readonly changes: readonly { readonly registrationId: string; readonly paths: readonly string[] }[];
};

/**
 * The builtin module is statically imported, so this survives replacement extension
 * factories during session.reload(). It closes the watcher-to-watcher race window.
 */
let reloadHandoff: ReloadHandoff | undefined;

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
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const subscribe = options.subscribe ?? createFsWatchEventSource();
	const logger = options.logger ?? createConfigReloadLogger(agentDir);
	const registrations = new Map<string, ConfigWatchRegistration>();
	const rejectedRegistrations = new Map<string, string>();
	const eventUnsubscribes: Array<() => void> = [];
	const pending = new Map<string, PendingChange>();
	let engine: ConfigReloadWatchEngine | undefined;
	let activeTargets: ActiveTarget[] = [];
	let currentContext: ExtensionContext | undefined;
	let started = false;
	let tornDown = false;
	let reloadInFlight = false;
	let deferredNoticeShown = false;
	let unavailableReloadLogged = false;
	let compactionRecheck: ReturnType<typeof setTimeout> | undefined;
	let changeChain: Promise<void> = Promise.resolve();

	const closeWatchers = (): void => {
		engine?.close();
		engine = undefined;
		activeTargets = [];
	};

	const clearCompactionRecheck = (): void => {
		if (compactionRecheck === undefined) return;
		(options.clock ?? defaultClock).clearTimeout(compactionRecheck);
		compactionRecheck = undefined;
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
		if (reloadInFlight || !currentContext) return;
		const groups = groupChangedPaths(change.changedPaths, activeTargets);
		const rearmDirectoryWatch = change.created.some((path) =>
			activeTargets.some((target) => target.rearmOnCreation === resolve(path)),
		);
		for (const [registrationId, paths] of groups) {
			const watchedPaths = excludeSelfWrites(paths, engine, agentDir, currentContext.cwd, logger);
			if (watchedPaths.length === 0) continue;

			const errors = await validateChangedPaths(
				registrationId,
				watchedPaths,
				registrations,
				agentDir,
				currentContext.cwd,
			);
			if (errors.length > 0) {
				rejectChange(currentContext, registrationId, watchedPaths, errors, logger, pi);
				continue;
			}

			addPending(pending, registrationId, watchedPaths);
			const deferred = !canRequestReload(currentContext);
			pi.events.emit(CONFIG_WATCH_CHANGED, {
				registrationId,
				paths: [...watchedPaths],
				deferred,
			});
			logger.info("change_detected", { registrationId, paths: watchedPaths, deferred });
		}
		if (rearmDirectoryWatch) rebuildWatchers(currentContext);
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
		closeWatchers();
		clearCompactionRecheck();
		const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
		const settings = resolveConfigReloadSettings(settingsManager);
		if (!settings.enabled || ctx.mode === "print" || ctx.mode === "json") {
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
			onRealChange: enqueueChange,
			onError: (error, path) => {
				logger.error("watcher_error", { path, message: errorMessage(error) });
			},
		});
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

		const changes = pendingChanges(pending);
		const paths = uniquePaths(changes.flatMap((change) => change.paths));
		reloadInFlight = true;
		tornDown = false;
		reloadHandoff = {
			hashesAtRequest: engine?.getBaselineSnapshot() ?? new Map<string, string>(),
			requestedAt: Date.now(),
			changes,
		};
		ctx.ui.notify(`Hot-reloading: ${formatPaths(paths)}`, "info");
		logger.info("reload_requested", { reason: "config changed", paths });

		try {
			await ctx.requestReload();
			if (!tornDown) {
				reloadInFlight = false;
				reloadHandoff = undefined;
			}
		} catch (error) {
			reloadInFlight = false;
			reloadHandoff = undefined;
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

	const processReloadHandoff = async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
		if (event.reason !== "reload" || !reloadHandoff) return;
		const handoff = reloadHandoff;
		reloadHandoff = undefined;
		const paths = uniquePaths(handoff.changes.flatMap((change) => change.paths));
		for (const change of handoff.changes) {
			pi.events.emit(CONFIG_WATCH_RELOADED, {
				registrationId: change.registrationId,
				paths: [...change.paths],
			});
		}
		ctx.ui.notify(`Hot-reloaded: ${formatPaths(paths)}`, "info");
		logger.info("reload_completed", { durationMs: Math.max(0, Date.now() - handoff.requestedAt) });

		const changedPaths = compareSnapshots(handoff.hashesAtRequest, engine?.getBaselineSnapshot() ?? new Map());
		if (changedPaths.length > 0) {
			enqueueChange({ changedPaths, created: [], deleted: [] });
			await changeChain;
		}
	};

	eventUnsubscribes.push(pi.events.on(CONFIG_WATCH_REGISTER, handleRegistration));
	eventUnsubscribes.push(pi.events.on(CONFIG_WATCH_UNREGISTER, handleUnregistration));

	pi.on("session_start", async (event, ctx) => {
		tornDown = false;
		started = true;
		currentContext = ctx;
		rebuildWatchers(ctx);
		await processReloadHandoff(event, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentContext = ctx;
		await flushPending();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		currentContext = ctx;
		await flushPending();
	});
	pi.on("project_trust", () => {
		if (currentContext) rebuildWatchers(currentContext);
		return { trusted: "undecided" };
	});
	pi.on("session_shutdown", (event) => {
		tornDown = true;
		started = false;
		currentContext = undefined;
		closeWatchers();
		clearCompactionRecheck();
		cleanupEventListeners();
		pending.clear();
		if (event.reason !== "reload") reloadHandoff = undefined;
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
	const addBuiltinDirectory = (id: string, path: string): void => {
		const resourcePath = resolve(path);
		if (isExistingDirectory(resourcePath)) {
			addBuiltin(id, { kind: "dir-recursive", path: resourcePath });
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
		if (name === "settings.json") return settings.watch.settings;
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
		addBuiltinDirectory("builtin-global-extensions", resolve(agentDir, "extensions"));
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
					allowList: ["settings.json"],
				});
			}
			if (settings.watch.prompts) {
				addBuiltinDirectory("builtin-project-prompts", resolve(projectDir, "prompts"));
			}
			if (settings.watch.skills) {
				addBuiltinDirectory("builtin-project-skills", resolve(projectDir, "skills"));
			}
			if (settings.watch.extensions) {
				addBuiltinDirectory("builtin-project-extensions", resolve(projectDir, "extensions"));
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
	const literalNames = filterGlobs.filter(
		(filterGlob) => !filterGlob.includes("*") && !filterGlob.includes("/") && !filterGlob.includes("\\\\"),
	);
	return literalNames.length > 0 ? literalNames : undefined;
}

function groupChangedPaths(paths: readonly string[], targets: readonly ActiveTarget[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const path of paths) {
		let matched = false;
		for (const activeTarget of targets) {
			if (!targetMatchesPath(activeTarget.target, path)) continue;
			const group = groups.get(activeTarget.registrationId) ?? [];
			if (!group.includes(path)) group.push(path);
			groups.set(activeTarget.registrationId, group);
			matched = true;
		}
		if (!matched) {
			const group = groups.get(BUILTIN_REGISTRATION_ID) ?? [];
			group.push(path);
			groups.set(BUILTIN_REGISTRATION_ID, group);
		}
	}
	return groups;
}

function targetMatchesPath(target: WatchTarget, path: string): boolean {
	const relativePath = relative(resolve(target.path), resolve(path));
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return false;
	if (target.kind === "dir" && relativePath.includes(sep)) return false;
	if (
		target.allowList &&
		!target.allowList.some((allowed) => relativePath === allowed || relativePath.startsWith(`${allowed}${sep}`))
	) {
		return false;
	}
	return target.filter?.(relativePath) ?? true;
}

function excludeSelfWrites(
	paths: readonly string[],
	engine: ConfigReloadWatchEngine | undefined,
	agentDir: string,
	cwd: string,
	logger: ConfigReloadLogger,
): string[] {
	const snapshot = engine?.getBaselineSnapshot();
	return paths.filter((path) => {
		if (!isSettingsPath(path, agentDir, cwd)) return true;
		const hash = snapshot?.get(path);
		if (hash === undefined || !wasSelfWrite(path, hash)) return true;
		logger.debug("self_write_suppressed", { path });
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
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isPlainObject(parsed)) return "settings.json must contain an object";
		// Keep validation aligned with SettingsManager's loader and migrations without duplicating migration rules.
		SettingsManager.inMemory(parsed as Partial<Settings>);
		return undefined;
	} catch (error) {
		return `Invalid settings.json: ${errorMessage(error)}`;
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

function registrationHasRestrictedTarget(
	registration: ConfigWatchRegistration,
	cwd: string,
	agentDir: string,
): boolean {
	const authPath = resolve(agentDir, "auth.json");
	const sessionsPath = resolve(agentDir, "sessions");
	const logsPath = resolve(agentDir, "logs");
	return registration.targets.some((target) => {
		const path = resolvePath(target.path, cwd, { trim: true });
		return (
			isWithin(path, authPath) ||
			isWithin(authPath, path) ||
			isWithin(path, sessionsPath) ||
			isWithin(path, logsPath)
		);
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

function joinConfigDir(cwd: string): string {
	return resolve(cwd, CONFIG_DIR_NAME);
}

function isSettingsPath(path: string, agentDir: string, cwd: string): boolean {
	return (
		resolve(path) === resolve(agentDir, "settings.json") ||
		resolve(path) === resolve(joinConfigDir(cwd), "settings.json")
	);
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
