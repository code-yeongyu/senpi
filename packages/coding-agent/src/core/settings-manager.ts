import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
import { SENPI_DEFAULT_RETRY_PROFILE } from "@earendil-works/pi-ai/utils/retry-profile/profiles";
import type {
	RetryPolicyProfile,
	RetryStagePolicy,
	RetryTieredHintStrategy,
} from "@earendil-works/pi-ai/utils/retry-profile/types";
import type { TuiMode as RendererTuiMode, ScrollViewScrollbar } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { findNearestParentConfigDir } from "../nearest-parent-config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { envValue } from "./brand.ts";
import type { CompactionSettings } from "./compaction-settings-access.ts";
import {
	compactionEnabled,
	compactionKeepRecentTokens,
	compactionReserveTokens,
} from "./compaction-settings-access.ts";
import { type ResolvedCompactionSettings, resolveCompactionSettings } from "./compaction-settings-resolver.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import { FILE_STORAGE_LOCK_OPTIONS } from "./lockfile-policy.ts";
import type { RetryPolicyOverride } from "./retry-fallback/profile-override.ts";
import { validateRetryProviderOverrides } from "./retry-fallback/profile-override.ts";
import {
	type ResolvedHintPolicySettings,
	type ResolvedRetryFallbackSettings,
	type RetrySettings as RetrySettingsConfig,
	resolveAbortServerSideFallback,
	resolveHintPolicySettings,
	resolveRetryFallbackSettings,
} from "./retry-fallback/settings.ts";
import type {
	ImageSettings,
	LookAtSettings,
	MarkdownSettings,
	MermaidRenderingMode,
	OpenAISettings,
	PromptCacheKeepAliveSettings,
	PromptCacheSettings,
	ThinkingBudgetsSettings,
} from "./settings-shapes.ts";
import type { BranchSummarySettings, TerminalSettings } from "./terminal-settings.ts";

export type * from "./settings-public-types.ts";

export const DEFAULT_STREAM_START_TIMEOUT_MS = 300_000;
export const DEFAULT_PROVIDER_STREAM_RETRY_TIMEOUT_MS = 30_000;

export type TuiMode = RendererTuiMode;
export type FullscreenExitOutput = "transcript" | "resume-hint";

/** Service tier remembered per model; "auto" is an explicit opt-out of an inherited priority tier. */
export type ModelServiceTier = "auto" | "flex" | "priority";

const THINKING_LEVEL_VALUES: ReadonlySet<string> = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const MODEL_SERVICE_TIER_VALUES: ReadonlySet<string> = new Set<ModelServiceTier>(["auto", "flex", "priority"]);

/** Opaque per-model memory key. Ids may contain `/` and `:`, so keys are never split back apart. */
function modelMemoryKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function readModelMemoryEntry(map: unknown, key: string, allowed: ReadonlySet<string>): string | undefined {
	if (typeof map !== "object" || map === null || Array.isArray(map)) return undefined;
	const value = (map as Record<string, unknown>)[key];
	return typeof value === "string" && allowed.has(value) ? value : undefined;
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
	offRecommendedModel?: boolean; // default: false
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 * - autoload=false: start empty and only apply explicit resource patterns
 */
export type PackageSource =
	| string
	| {
			source: string;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
			hooks?: string[];
	  };

export interface ExperimentalSettings {
	bashEvalOnly?: boolean;
	workflowEvalOnly?: boolean;
	sharedHost?: boolean;
}

export interface Settings {
	lastChangelogVersion?: string;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>; // `${provider}/${id}` -> effective thinking level for that model
	modelLastOnThinkingLevels?: Record<string, ThinkingLevel>; // `${provider}/${id}` -> last non-off thinking level
	modelServiceTiers?: Record<string, ModelServiceTier>; // `${provider}/${id}` -> last service tier set for that model
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettingsConfig;
	hideThinkingBlock?: boolean;
	smoothStreaming?: boolean; // default: true
	smoothStreamingFps?: number; // default: 60, clamped to 30-120 when read
	showCacheMissNotices?: boolean; // default: false - show prompt-cache miss and compaction cost notices
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows); supports leading ~ expansion
	quietStartup?: boolean;
	tips?: boolean; // default: true
	tipsHistory?: Record<string, number>; // tipId -> epoch ms last shown
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
	enableAnalytics?: boolean; // default: false - opt-in analytics data sharing
	trackingId?: string; // analytics tracking identifier, generated when analytics is enabled
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	enabledBuiltinExtensions?: string[]; // Optional allowlist of builtin extension ids to load (default: all)
	disabledBuiltinExtensions?: string[]; // Builtin extension ids to skip loading
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	hooks?: string[];
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	terminal?: TerminalSettings;
	promptCache?: PromptCacheSettings;
	images?: ImageSettings;
	lookAt?: LookAtSettings;
	recommendedModels?: string[]; // Preferred default model ids, in priority order
	favoriteModels?: string[]; // Model patterns for Ctrl+P cycling (same format as --models CLI flag)
	enabledModels?: string[]; // Legacy global model narrowing patterns (same format as --models CLI flag)
	defaultTools?: string[]; // Initial built-in tool selection
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	outputPad?: 0 | 1; // Horizontal padding for chat message output (default: 1)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	openai?: OpenAISettings;
	httpProxy?: string; // Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	tuiMode?: TuiMode; // default: "regular"
	fullscreenExitOutput?: FullscreenExitOutput; // default: "transcript"; no effect in regular TUI mode
	fullscreenScrollbar?: ScrollViewScrollbar; // default: "auto"; no effect in regular TUI mode
	experimental?: ExperimentalSettings;
}

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result = deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
	if (overrides.retry?.fallbackChains !== undefined) {
		result.retry = {
			...result.retry,
			fallbackChains: structuredClone(overrides.retry.fallbackChains),
		};
	}
	return result;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export type SettingsScope = "global" | "project";
export type SettingsFormat = "jsonc" | "json";
export type SettingsSourceReason = "explicit-jsonc" | "json-only";

export interface SettingsSourceSelection {
	path: string;
	format: SettingsFormat;
	reason: SettingsSourceReason;
	scope: SettingsScope;
}

export type SettingsSourceListener = (source: SettingsSourceSelection) => void;

/** Parse JSON or JSONC without changing comment-like text inside strings. */
export function parseSettingsJson(content: string): Record<string, unknown> {
	content = stripBom(content);
	const withoutComments: string[] = [];
	let inString = false;
	let escaped = false;

	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		const next = content[index + 1];
		if (inString) {
			withoutComments.push(char);
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			withoutComments.push(char);
			continue;
		}
		if (char === "/" && next === "/") {
			withoutComments.push(" ", " ");
			index += 2;
			while (index < content.length && content[index] !== "\n" && content[index] !== "\r") {
				withoutComments.push(" ");
				index += 1;
			}
			if (index < content.length) withoutComments.push(content[index]);
			continue;
		}
		if (char === "/" && next === "*") {
			withoutComments.push(" ", " ");
			index += 2;
			let closed = false;
			for (; index < content.length; index += 1) {
				if (content[index] === "*" && content[index + 1] === "/") {
					withoutComments.push(" ", " ");
					index += 1;
					closed = true;
					break;
				}
				withoutComments.push(content[index] === "\n" || content[index] === "\r" ? content[index] : " ");
			}
			if (!closed) throw new SyntaxError("Unterminated block comment in settings");
			continue;
		}
		withoutComments.push(char);
	}

	const normalized = withoutComments;
	inString = false;
	escaped = false;
	for (let index = 0; index < normalized.length; index += 1) {
		const char = normalized[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char !== ",") continue;
		let nextIndex = index + 1;
		while (nextIndex < normalized.length && /\s/.test(normalized[nextIndex])) nextIndex += 1;
		if (normalized[nextIndex] === "}" || normalized[nextIndex] === "]") normalized[index] = " ";
	}

	const parsed: unknown = JSON.parse(normalized.join(""));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new TypeError("Settings must contain a JSON object");
	}
	return parsed as Record<string, unknown>;
}

const SELF_WRITE_TTL_MS = 15_000;
const MAX_SELF_WRITES_PER_PATH = 8;
const selfWritesByPath = new Map<string, Map<string, number>>();
let selfWriteClock: () => number = Date.now;

function recordSelfWrite(absPath: string, content: string): void {
	const now = selfWriteClock();
	const writes = selfWritesByPath.get(absPath) ?? new Map<string, number>();

	for (const [hash, recordedAt] of writes) {
		if (now - recordedAt > SELF_WRITE_TTL_MS) {
			writes.delete(hash);
		}
	}

	const hash = createHash("sha256").update(content).digest("hex");
	writes.delete(hash);
	writes.set(hash, now);
	while (writes.size > MAX_SELF_WRITES_PER_PATH) {
		const oldestHash = writes.keys().next().value;
		if (oldestHash === undefined) {
			break;
		}
		writes.delete(oldestHash);
	}
	selfWritesByPath.set(absPath, writes);
}

/**
 * Returns whether a settings content hash was recently written by this process.
 * A matching entry is consumed so a later identical external edit is not suppressed.
 */
export function wasSelfWrite(absPath: string, hash: string): boolean {
	const writes = selfWritesByPath.get(absPath);
	if (!writes) {
		return false;
	}

	const now = selfWriteClock();
	for (const [trackedHash, recordedAt] of writes) {
		if (now - recordedAt > SELF_WRITE_TTL_MS) {
			writes.delete(trackedHash);
		}
	}

	if (!writes.delete(hash)) {
		if (writes.size === 0) {
			selfWritesByPath.delete(absPath);
		}
		return false;
	}
	if (writes.size === 0) {
		selfWritesByPath.delete(absPath);
	}
	return true;
}

/** Test-only hook for isolating process-wide self-write tracker state. */
export function __resetSelfWriteTrackerForTests(): void {
	selfWritesByPath.clear();
}

/** Test-only hook for deterministically advancing the self-write tracker clock. */
export function __setSelfWriteTrackerClockForTests(clock: (() => number) | undefined = undefined): void {
	selfWriteClock = clock ?? Date.now;
}

function getSettingsDirectory(cwd: string, agentDir: string, scope: SettingsScope, homeDir: string): string {
	if (scope === "global") return resolvePath(agentDir);
	const resolvedCwd = resolvePath(cwd);
	return findNearestParentConfigDir(resolvedCwd, homeDir, CONFIG_DIR_NAME) ?? join(resolvedCwd, CONFIG_DIR_NAME);
}

/** Resolve the existing settings source, preferring JSONC when both formats exist. */
export function resolveSettingsSource(
	cwd: string,
	agentDir: string,
	scope: SettingsScope,
	homeDir: string = homedir(),
): SettingsSourceSelection | undefined {
	const directory = getSettingsDirectory(cwd, agentDir, scope, homeDir);
	const jsoncPath = join(directory, "settings.jsonc");
	if (existsSync(jsoncPath)) {
		return {
			path: jsoncPath,
			format: "jsonc",
			reason: "explicit-jsonc",
			scope,
		};
	}
	const jsonPath = join(directory, "settings.json");
	if (existsSync(jsonPath)) {
		return { path: jsonPath, format: "json", reason: "json-only", scope };
	}
	return undefined;
}

/** Returns the selected settings path, or the legacy JSON write target when no source exists. */
export function getSettingsPath(
	cwd: string,
	agentDir: string,
	scope: SettingsScope,
	homeDir: string = homedir(),
): string {
	return (
		resolveSettingsSource(cwd, agentDir, scope, homeDir)?.path ??
		join(getSettingsDirectory(cwd, agentDir, scope, homeDir), "settings.json")
	);
}

/** Returns the stable virtual path used to identify in-memory settings storage writes. */
export function getInMemorySettingsPath(scope: SettingsScope): string {
	return scope === "global" ? "/__senpi_in_memory__/settings.json" : "/__senpi_in_memory__/.senpi/settings.json";
}

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	selectSource?(scope: SettingsScope): SettingsSourceSelection | undefined;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

type SettingsPaths = Partial<Record<SettingsScope, string>>;

function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly homeDir: string;

	constructor(cwd: string, agentDir: string, homeDir: string = homedir()) {
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.homeDir = homeDir;
		this.globalSettingsPath = getSettingsPath(cwd, agentDir, "global", homeDir);
		this.projectSettingsPath = getSettingsPath(cwd, agentDir, "project", homeDir);
	}

	selectSource(scope: SettingsScope): SettingsSourceSelection | undefined {
		const source = resolveSettingsSource(this.cwd, this.agentDir, scope, this.homeDir);
		const path =
			source?.path ?? join(getSettingsDirectory(this.cwd, this.agentDir, scope, this.homeDir), "settings.json");
		if (scope === "global") this.globalSettingsPath = path;
		else this.projectSettingsPath = path;
		return source;
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { ...FILE_STORAGE_LOCK_OPTIONS });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				// Atomics.wait sleeps the thread without spinning, so contended lock retries
				// no longer burn a CPU core per waiter (root cause of the TUI freeze under
				// provider-error storms). Stays synchronous to keep callers unchanged.
				const sleeper = new Int32Array(new SharedArrayBuffer(4));
				Atomics.wait(sleeper, 0, 0, delayMs);
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		// Read without the lock: writers publish atomically via temp+rename below, so
		// a reader can never observe partial content. Read-only callers therefore skip
		// lock acquisition entirely (no lock churn, no lock-dir filesystem events).
		const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
		let next = fn(current);
		if (next === undefined) {
			return;
		}
		// Only create directory when we actually need to write
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const release = this.acquireLockSyncWithRetry(path);
		try {
			const underLock = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
			if (underLock !== current) {
				// Lost a write race: re-merge against the winner's content under the lock.
				next = fn(underLock);
			}
			if (next !== undefined) {
				// Publish atomically: write a same-directory temp file, then rename over
				// the settings path so lock-free readers never see a torn write.
				const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
				try {
					writeFileSync(tempPath, next, "utf-8");
					recordSelfWrite(path, next);
					renameSync(tempPath, path);
				} catch (error) {
					rmSync(tempPath, { force: true });
					throw error;
				}
			}
		} finally {
			release();
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
			recordSelfWrite(getInMemorySettingsPath(scope), next);
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private settingsPaths: SettingsPaths;
	private selectedSources = new Map<SettingsScope, SettingsSourceSelection>();
	private sourceListeners: SettingsSourceListener[] = [];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		initialSources: readonly SettingsSourceSelection[] = [],
		settingsPaths: SettingsPaths = {},
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settingsPaths = settingsPaths;
		for (const source of initialSources) this.selectedSources.set(source.scope, source);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage, options);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const initialSources: SettingsSourceSelection[] = [];
		const settingsPaths: SettingsPaths = {};
		const globalSource = storage.selectSource?.("global");
		if (globalSource) {
			initialSources.push(globalSource);
			settingsPaths.global = globalSource.path;
		}
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectSource = projectTrusted ? storage.selectSource?.("project") : undefined;
		if (projectSource) {
			initialSources.push(projectSource);
			settingsPaths.project = projectSource.path;
		}
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			initialSources,
			settingsPaths,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		return SettingsManager.migrateSettings(parseSettingsJson(content));
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return {
				settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted),
				error: null,
			};
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	getPromptCacheGoalBackstopMaxSeconds(): number {
		return (
			this.projectSettings.promptCache?.goalBackstopMaxSeconds ??
			this.globalSettings.promptCache?.goalBackstopMaxSeconds ??
			3570
		);
	}

	getPromptCacheKeepAliveSettings(): Required<PromptCacheKeepAliveSettings> {
		const configured = this.settings.promptCache?.keepAlive;
		return {
			enabled: configured?.enabled ?? false,
			maxRequestsPerSession: configured?.maxRequestsPerSession ?? 3,
			maxCostUsdPerSession: configured?.maxCostUsdPerSession ?? 0.05,
			marginSeconds: configured?.marginSeconds ?? 60,
		};
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		this.selectAndPublishSource("project");
		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		this.selectAndPublishSource("global");
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (this.projectTrusted) this.selectAndPublishSource("project");
		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	getSelectedSettingsSources(): SettingsSourceSelection[] {
		return [...this.selectedSources.values()].map((source) => ({ ...source }));
	}

	subscribeToSourceSelection(listener: SettingsSourceListener): () => void {
		this.sourceListeners.push(listener);
		return () => {
			const index = this.sourceListeners.indexOf(listener);
			if (index !== -1) this.sourceListeners.splice(index, 1);
		};
	}

	private selectAndPublishSource(scope: SettingsScope): void {
		const source = this.storage.selectSource?.(scope);
		if (!source) {
			this.selectedSources.delete(scope);
			return;
		}
		this.selectedSources.set(scope, source);
		for (const listener of this.sourceListeners) listener({ ...source });
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(toSettingsError(scope, normalizedError, this.settingsPaths[scope]));
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current ? SettingsManager.migrateSettings(parseSettingsJson(current)) : {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "all";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	/** Thinking level last set for this exact model, or undefined when unknown/invalid on disk. */
	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return readModelMemoryEntry(
			this.settings.modelThinkingLevels,
			modelMemoryKey(provider, modelId),
			THINKING_LEVEL_VALUES,
		) as ThinkingLevel | undefined;
	}

	/** Remember (or with `undefined`, forget) this model's effective thinking level in GLOBAL settings. */
	setModelThinkingLevel(
		provider: string,
		modelId: string,
		level: ThinkingLevel | undefined,
		options: { preserveLastOn?: boolean } = {},
	): void {
		const key = modelMemoryKey(provider, modelId);
		const existing = this.globalSettings.modelThinkingLevels;
		const map: Record<string, ThinkingLevel> =
			typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...existing } : {};
		if (level === undefined) {
			delete map[key];
		} else {
			map[key] = level;
		}
		this.globalSettings.modelThinkingLevels = map;
		// Nested key only: concurrent sessions writing OTHER models must survive the merge.
		this.markModified("modelThinkingLevels", key);

		// `off` is durable effective state, but it must not erase the level `/reasoning on` restores.
		if (level !== "off" && !options.preserveLastOn) {
			this.updateModelLastOnThinkingLevel(key, level);
		}
		this.save();
	}

	/** Last non-off thinking level for this exact model, or undefined when unknown/invalid on disk. */
	getModelLastOnThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		const level = readModelMemoryEntry(
			this.settings.modelLastOnThinkingLevels,
			modelMemoryKey(provider, modelId),
			THINKING_LEVEL_VALUES,
		) as ThinkingLevel | undefined;
		return level === "off" ? undefined : level;
	}

	/** Remember (or with `undefined`, forget) this model's last non-off level in GLOBAL settings. */
	setModelLastOnThinkingLevel(provider: string, modelId: string, level: ThinkingLevel | undefined): void {
		this.updateModelLastOnThinkingLevel(modelMemoryKey(provider, modelId), level === "off" ? undefined : level);
		this.save();
	}

	private updateModelLastOnThinkingLevel(key: string, level: ThinkingLevel | undefined): void {
		const existing = this.globalSettings.modelLastOnThinkingLevels;
		const map: Record<string, ThinkingLevel> =
			typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...existing } : {};
		if (level === undefined) {
			delete map[key];
		} else {
			map[key] = level;
		}
		this.globalSettings.modelLastOnThinkingLevels = map;
		this.markModified("modelLastOnThinkingLevels", key);
	}

	/** Service tier last set for this exact model, or undefined when unknown/invalid on disk. */
	getModelServiceTier(provider: string, modelId: string): ModelServiceTier | undefined {
		return readModelMemoryEntry(
			this.settings.modelServiceTiers,
			modelMemoryKey(provider, modelId),
			MODEL_SERVICE_TIER_VALUES,
		) as ModelServiceTier | undefined;
	}

	/** Remember (or with `undefined`, forget) this model's service tier in GLOBAL settings. */
	setModelServiceTier(provider: string, modelId: string, tier: ModelServiceTier | undefined): void {
		const key = modelMemoryKey(provider, modelId);
		const existing = this.globalSettings.modelServiceTiers;
		const map: Record<string, ModelServiceTier> =
			typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...existing } : {};
		if (tier === undefined) {
			delete map[key];
		} else {
			map[key] = tier;
		}
		this.globalSettings.modelServiceTiers = map;
		this.markModified("modelServiceTiers", key);
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	getOpenAIServiceTier(): OpenAISettings["serviceTier"] {
		return this.settings.openai?.serviceTier;
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return compactionEnabled(this.settings.compaction);
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return compactionReserveTokens(this.settings.compaction);
	}

	getCompactionKeepRecentTokens(): number {
		return compactionKeepRecentTokens(this.settings.compaction);
	}

	getCompactionSettings(): ResolvedCompactionSettings {
		return resolveCompactionSettings(this.settings.compaction);
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): {
		enabled: boolean;
		maxRetries: number;
		baseDelayMs: number;
	} {
		return {
			enabled: this.getRetryEnabled(),
			// Derived, not duplicated: the one `retry.maxRetries` key must mean the
			// same budget on every consumer, so the default tracks the shipped profile.
			maxRetries: this.settings.retry?.maxRetries ?? SENPI_DEFAULT_RETRY_PROFILE.turn.maxRetries,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	/**
	 * Abort a turn when the provider silently substitutes the requested model
	 * after a classifier decline, so model choice stays with the configured
	 * fallback chain instead of the provider. Defaults to enabled.
	 */
	getAbortServerSideFallback(): boolean {
		return resolveAbortServerSideFallback(this.settings.retry);
	}

	/** Raw retry.fallbackChains value before sanitization, for startup validation warnings. */
	getRawFallbackChains(): unknown {
		return this.settings.retry?.fallbackChains;
	}

	/**
	 * Which scope supplied `retry.fallbackChains`, so a validation warning can name
	 * the file to open. Project scope wins because it replaces the global chain map
	 * wholesale. Returns undefined when no scope configured chains and the resolved
	 * map is therefore the shipped defaults.
	 */
	getFallbackChainsScope(): SettingsScope | undefined {
		if (this.projectSettings.retry?.fallbackChains !== undefined) return "project";
		if (this.globalSettings.retry?.fallbackChains !== undefined) return "global";
		return undefined;
	}

	getRetryFallbackSettings(): ResolvedRetryFallbackSettings {
		return resolveRetryFallbackSettings(this.settings.retry);
	}

	getHintPolicySettings(): ResolvedHintPolicySettings {
		return resolveHintPolicySettings(this.settings.retry);
	}

	setFallbackChain(key: string, entries: string[]): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		const chains = this.getGlobalFallbackChains();
		this.globalSettings.retry.fallbackChains = {
			...chains,
			[key]: [...entries],
		};
		this.markModified("retry", "fallbackChains");
		this.save();
	}

	removeFallbackChain(key: string): void {
		const chains = this.getGlobalFallbackChains();
		if (!(key in chains)) {
			return;
		}
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		delete chains[key];
		this.globalSettings.retry.fallbackChains = chains;
		this.markModified("retry", "fallbackChains");
		this.save();
	}

	setModelFallbackEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.modelFallback = enabled;
		this.markModified("retry", "modelFallback");
		this.save();
	}

	setFallbackRevertPolicy(policy: "cooldown-expiry" | "never"): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.fallbackRevertPolicy = policy;
		this.markModified("retry", "fallbackRevertPolicy");
		this.save();
	}

	private getGlobalFallbackChains(): Record<string, string[]> {
		const fallbackChains = this.globalSettings.retry?.fallbackChains;
		if (typeof fallbackChains !== "object" || fallbackChains === null || Array.isArray(fallbackChains)) {
			return {};
		}
		const chains: Record<string, string[]> = {};
		for (const [key, entries] of Object.entries(fallbackChains)) {
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				chains[key] = [...entries];
			}
		}
		return chains;
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getProviderRetrySettings(): {
		timeoutMs?: number;
		maxRetries?: number;
		maxRetryDelayMs: number;
	} {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	/**
	 * Resolve the effective retry profile for a provider. Precedence:
	 * 1) SENPI_DEFAULT_RETRY_PROFILE is the base.
	 * 2) A provider-declared retryPolicy replaces the base entirely.
	 * 3) User global retry.maxRetries / retry.baseDelayMs apply ONLY when the
	 *    provider declared NO profile (they must not silently re-tune one).
	 * 4) Validated retry.providers.<id> patches scheduling knobs last.
	 * 5) retry.enabled === false is a hard gate: resolved turn.enabled is false.
	 */
	resolveRetryProfile(provider: { id: string; retryPolicy?: RetryPolicyProfile } | undefined): RetryPolicyProfile {
		const base = provider?.retryPolicy ?? SENPI_DEFAULT_RETRY_PROFILE;
		const declared = provider?.retryPolicy !== undefined;

		const turnBackoff = { ...base.turn.backoff };
		if (!declared) {
			if (this.settings.retry?.maxRetries !== undefined) {
				turnBackoff.baseDelayMs = this.settings.retry.baseDelayMs ?? turnBackoff.baseDelayMs;
			}
		}

		let turnMaxRetries = base.turn.maxRetries;
		let turnBaseDelayMs = turnBackoff.baseDelayMs;
		if (!declared) {
			if (this.settings.retry?.maxRetries !== undefined) turnMaxRetries = this.settings.retry.maxRetries;
			if (this.settings.retry?.baseDelayMs !== undefined) turnBaseDelayMs = this.settings.retry.baseDelayMs;
		}

		const providerOverride = this._resolveRetryProviderOverride(provider?.id);
		if (providerOverride?.turn?.maxRetries !== undefined) turnMaxRetries = providerOverride.turn.maxRetries;
		if (providerOverride?.turn?.baseDelayMs !== undefined) turnBaseDelayMs = providerOverride.turn.baseDelayMs;

		const turnEnabled = this.getRetryEnabled() ? (providerOverride?.turn?.enabled ?? base.turn.enabled) : false;

		const tierStrategy: RetryTieredHintStrategy =
			base.turn.serverHint.mode === "tiered"
				? base.turn.serverHint.strategy
				: () => {
						throw new Error("not tiered");
					};

		const turn: RetryStagePolicy = {
			enabled: turnEnabled,
			maxRetries: turnMaxRetries,
			backoff: { ...base.turn.backoff, baseDelayMs: turnBaseDelayMs },
			extractServerHint: base.turn.extractServerHint,
			serverHint:
				base.turn.serverHint.mode === "tiered" ? { mode: "tiered", strategy: tierStrategy } : base.turn.serverHint,
			classify: base.turn.classify,
		};

		return {
			id: base.id,
			providerRequest: base.providerRequest,
			turn,
			fallback: base.fallback,
		};
	}

	private _resolveRetryProviderOverride(providerId: string | undefined): RetryPolicyOverride | undefined {
		if (providerId === undefined) return undefined;
		const raw = this.settings.retry?.providers;
		if (raw === undefined) return undefined;
		const { overrides } = validateRetryProviderOverrides(raw, new Set([providerId]));
		return overrides[providerId];
	}

	/**
	 * First-request liveness cap for retries of known provider stream/transport
	 * timeouts. `retry.provider.streamRetryTimeoutMs` overrides the 30s default;
	 * 0 disables the cap without disabling queue deferral. The retry path clamps
	 * only already-enabled stream guards, so this setting never re-enables one.
	 */
	getProviderStreamRetryTimeoutMs(): number | undefined {
		const explicit = this.settings.retry?.provider?.streamRetryTimeoutMs;
		if (explicit !== undefined) {
			return explicit > 0 ? explicit : undefined;
		}
		return DEFAULT_PROVIDER_STREAM_RETRY_TIMEOUT_MS;
	}

	/**
	 * Idle timeout for the agent loop's provider event reader. Defaults to
	 * httpIdleTimeoutMs so streams that stop delivering events (e.g. a
	 * connection that silently died after a network change) fail with a
	 * retryable idle-timeout error instead of hanging the session forever.
	 * `retry.provider.timeoutMs` overrides it; an httpIdleTimeoutMs of 0
	 * ("disabled") disables the reader guard as well.
	 */
	getAgentStreamIdleTimeoutMs(): number | undefined {
		const providerTimeoutMs = this.settings.retry?.provider?.timeoutMs;
		if (providerTimeoutMs !== undefined) {
			return providerTimeoutMs;
		}
		const httpIdleTimeoutMs = this.getHttpIdleTimeoutMs();
		return httpIdleTimeoutMs === 0 ? undefined : httpIdleTimeoutMs;
	}

	/**
	 * Bound on the time to the FIRST provider stream event. Providers only emit
	 * their first event once the HTTP response begins, so a dead upstream that
	 * accepts the request but never answers is otherwise bounded only by the
	 * idle timeout (default 5 minutes) — long enough to make a session feel
	 * permanently stuck. `retry.provider.streamStartTimeoutMs` overrides the
	 * 300s default (0 disables). The default never exceeds the idle timeout and
	 * is disabled together with a disabled idle guard.
	 */
	getAgentStreamStartTimeoutMs(): number | undefined {
		const explicit = this.settings.retry?.provider?.streamStartTimeoutMs;
		if (explicit !== undefined) {
			return explicit > 0 ? explicit : undefined;
		}
		const idleTimeoutMs = this.getAgentStreamIdleTimeoutMs();
		if (idleTimeoutMs === undefined) {
			return undefined;
		}
		return Math.min(DEFAULT_STREAM_START_TIMEOUT_MS, idleTimeoutMs);
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	getSmoothStreaming(): boolean {
		return this.settings.smoothStreaming ?? true;
	}

	getSmoothStreamingFps(): number {
		const fps = this.settings.smoothStreamingFps;
		if (typeof fps !== "number" || !Number.isFinite(fps)) {
			return 60;
		}
		return Math.min(120, Math.max(30, fps));
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? false;
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	setSmoothStreaming(enabled: boolean): void {
		this.globalSettings.smoothStreaming = enabled;
		this.markModified("smoothStreaming");
		this.save();
	}

	setSmoothStreamingFps(fps: number): void {
		this.globalSettings.smoothStreamingFps = fps;
		this.markModified("smoothStreamingFps");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.globalSettings.showCacheMissNotices = show;
		this.markModified("showCacheMissNotices");
		this.save();
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getTipsEnabled(): boolean {
		return this.settings.tips ?? true;
	}

	getTipsHistory(): Record<string, number> {
		const history = this.settings.tipsHistory;
		if (typeof history !== "object" || history === null || Array.isArray(history)) {
			return {};
		}
		return { ...history };
	}

	setTipsHistory(history: Record<string, number>): void {
		this.globalSettings.tipsHistory = history;
		this.markModified("tipsHistory");
		this.save();
	}

	setTipShown(tipId: string, timestamp: number): void {
		const history = this.getTipsHistory();
		history[tipId] = timestamp;
		this.globalSettings.tipsHistory = history;
		this.markModified("tipsHistory", tipId);
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	getDisabledBuiltinExtensions(): string[] {
		return [...(this.settings.disabledBuiltinExtensions ?? [])];
	}

	getEnabledBuiltinExtensions(): string[] | undefined {
		return this.settings.enabledBuiltinExtensions ? [...this.settings.enabledBuiltinExtensions] : undefined;
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return envValue("CLEAR_ON_SHRINK") === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getTuiMode(): TuiMode {
		return this.settings.tuiMode === "fullscreen" ? "fullscreen" : "regular";
	}

	setTuiMode(mode: TuiMode): void {
		this.globalSettings.tuiMode = mode;
		this.markModified("tuiMode");
		this.save();
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.globalSettings.fullscreenExitOutput = output;
		this.markModified("fullscreenExitOutput");
		this.save();
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.globalSettings.fullscreenScrollbar = mode;
		this.markModified("fullscreenScrollbar");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	getMaxHistoricalImages(): number | undefined {
		const value = this.settings.images?.maxHistoricalImages;
		return Number.isInteger(value) && value !== undefined && value >= 0 ? value : undefined;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	getRecommendedModels(): string[] | undefined {
		return this.settings.recommendedModels ? [...this.settings.recommendedModels] : undefined;
	}

	getFavoriteModels(): string[] | undefined {
		return this.settings.favoriteModels;
	}

	setFavoriteModels(patterns: string[] | undefined): void {
		this.globalSettings.favoriteModels = patterns;
		this.markModified("favoriteModels");
		this.save();
	}

	getDefaultTools(): string[] | undefined {
		const tools = this.settings.defaultTools;
		return tools ? [...tools] : undefined;
	}

	getExperimentalBashEvalOnly(): boolean {
		return this.settings.experimental?.bashEvalOnly === true;
	}

	getExperimentalWorkflowEvalOnly(): boolean {
		return this.settings.experimental?.workflowEvalOnly === true;
	}

	getExperimentalSharedHost(): boolean {
		return this.settings.experimental?.sharedHost === true;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? envValue("HARDWARE_CURSOR") === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
