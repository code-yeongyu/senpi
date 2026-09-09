import { statSync } from "node:fs";
import { getAgentDir } from "../../../../config.ts";
import {
	FileSettingsStorage,
	getSettingsPath,
	parseSettingsJson,
	type Settings,
	SettingsManager,
} from "../../../settings-manager.ts";

export type CursorCliOauthExecutionMode = "agent" | "plan";
export type CursorCliOauthResumeMode = "auto" | "off";

export interface CursorCliOauthProviderSettings {
	/**
	 * Explicit senpi-side opt-in for the AMBIENT lane (host-CLI-derived native
	 * credential bootstrap). Defaults to false: a logged-in `cursor-agent` on the
	 * host is not consent to spend that subscription from senpi.
	 */
	readonly enabled: boolean;
	/**
	 * True only when a settings layer or the environment set `enabled` to false
	 * verbatim. That is a kill switch and outranks stored accounts, while a merely
	 * absent flag leaves an explicit senpi-side login usable.
	 */
	readonly explicitlyDisabled: boolean;
	readonly executablePath: string | undefined;
	readonly forceExecution: boolean;
	readonly noApprovalAcknowledgedAt: string | undefined;
	readonly executionMode: CursorCliOauthExecutionMode;
	readonly resumeMode: CursorCliOauthResumeMode;
	readonly pinnedAccount: string | undefined;
	readonly contextRecapOnModelSwitch: boolean;
	readonly modelCatalogTtlHours: number;
	readonly sandboxMode: string | undefined;
	/** Exact full commands the spawned CLI must refuse; globs are not supported. */
	readonly denyCommands?: string[];
}

type SettingsWithCursorCliOauthProvider = Settings & {
	cursorCliOauthProvider?: unknown;
};

type Environment = Readonly<Record<string, string | undefined>>;
type ParsedSettings = Partial<CursorCliOauthProviderSettings>;

const DEFAULT_SETTINGS: CursorCliOauthProviderSettings = {
	enabled: false,
	explicitlyDisabled: false,
	executablePath: undefined,
	forceExecution: true,
	noApprovalAcknowledgedAt: undefined,
	executionMode: "agent",
	resumeMode: "auto",
	pinnedAccount: undefined,
	contextRecapOnModelSwitch: true,
	modelCatalogTtlHours: 24,
	sandboxMode: undefined,
	denyCommands: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseEnvironmentBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.toLowerCase()) {
		case "1":
		case "true":
			return true;
		case "0":
		case "false":
			return false;
		default:
			return undefined;
	}
}

function parseNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Exact full commands only: string entries are trimmed, non-strings and empties are dropped. */
function parseDenyCommands(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((command) => command.length > 0);
}

/** Comma-separated exact full commands; a missing or empty value leaves settings untouched. */
function parseEnvironmentDenyCommands(value: string | undefined): string[] | undefined {
	if (value === undefined || value.length === 0) return undefined;
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((command) => command.length > 0);
}

function parseIsoString(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
		return undefined;
	}
	return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function parseExecutionMode(value: unknown): CursorCliOauthExecutionMode | undefined {
	return value === "agent" || value === "plan" ? value : undefined;
}

function parseResumeMode(value: unknown): CursorCliOauthResumeMode | undefined {
	return value === "auto" || value === "off" ? value : undefined;
}

function parsePositiveFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseEnvironmentPositiveFiniteNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseProviderSettings(value: unknown): ParsedSettings {
	if (!isRecord(value)) return {};
	const enabled = parseBoolean(value.enabled);
	const executablePath = parseNonEmptyString(value.executablePath);
	const forceExecution = parseBoolean(value.forceExecution);
	const noApprovalAcknowledgedAt = parseIsoString(value.noApprovalAcknowledgedAt);
	const executionMode = parseExecutionMode(value.executionMode);
	const resumeMode = parseResumeMode(value.resumeMode);
	const pinnedAccount = parseNonEmptyString(value.pinnedAccount);
	const contextRecapOnModelSwitch = parseBoolean(value.contextRecapOnModelSwitch);
	const modelCatalogTtlHours = parsePositiveFiniteNumber(value.modelCatalogTtlHours);
	const sandboxMode = parseNonEmptyString(value.sandboxMode);
	const denyCommands = parseDenyCommands(value.denyCommands);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(executablePath !== undefined ? { executablePath } : {}),
		...(forceExecution !== undefined ? { forceExecution } : {}),
		...(noApprovalAcknowledgedAt !== undefined ? { noApprovalAcknowledgedAt } : {}),
		...(executionMode !== undefined ? { executionMode } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
		...(pinnedAccount !== undefined ? { pinnedAccount } : {}),
		...(contextRecapOnModelSwitch !== undefined ? { contextRecapOnModelSwitch } : {}),
		...(modelCatalogTtlHours !== undefined ? { modelCatalogTtlHours } : {}),
		...(sandboxMode !== undefined ? { sandboxMode } : {}),
		...(denyCommands !== undefined ? { denyCommands } : {}),
	};
}

function parseEnvironmentSettings(environment: Environment): ParsedSettings {
	const executablePath =
		parseNonEmptyString(environment.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE) ??
		parseNonEmptyString(environment.CURSOR_AGENT_EXECUTABLE);
	const enabled = parseEnvironmentBoolean(environment.SENPI_CURSOR_CLI_OAUTH_ENABLED);
	const forceExecution = parseEnvironmentBoolean(environment.SENPI_CURSOR_CLI_OAUTH_FORCE);
	const executionMode = parseExecutionMode(environment.SENPI_CURSOR_CLI_OAUTH_EXECUTION_MODE);
	const resumeMode = parseResumeMode(environment.SENPI_CURSOR_CLI_OAUTH_RESUME);
	const pinnedAccount = parseNonEmptyString(environment.SENPI_CURSOR_CLI_OAUTH_PINNED_ACCOUNT);
	const contextRecapOnModelSwitch = parseEnvironmentBoolean(environment.SENPI_CURSOR_CLI_OAUTH_RECAP);
	const modelCatalogTtlHours = parseEnvironmentPositiveFiniteNumber(
		environment.SENPI_CURSOR_CLI_OAUTH_MODEL_CATALOG_TTL_HOURS,
	);
	const sandboxMode = parseNonEmptyString(environment.SENPI_CURSOR_CLI_OAUTH_SANDBOX_MODE);
	const denyCommands = parseEnvironmentDenyCommands(environment.SENPI_CURSOR_CLI_OAUTH_DENY_COMMANDS);
	return {
		...(executablePath !== undefined ? { executablePath } : {}),
		...(enabled !== undefined ? { enabled } : {}),
		...(forceExecution !== undefined ? { forceExecution } : {}),
		...(executionMode !== undefined ? { executionMode } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
		...(pinnedAccount !== undefined ? { pinnedAccount } : {}),
		...(contextRecapOnModelSwitch !== undefined ? { contextRecapOnModelSwitch } : {}),
		...(modelCatalogTtlHours !== undefined ? { modelCatalogTtlHours } : {}),
		...(sandboxMode !== undefined ? { sandboxMode } : {}),
		...(denyCommands !== undefined ? { denyCommands } : {}),
	};
}

function resolveSettings(...layers: readonly ParsedSettings[]): CursorCliOauthProviderSettings {
	const resolved: CursorCliOauthProviderSettings = Object.assign({}, DEFAULT_SETTINGS, ...layers);
	// The last layer that names `enabled` wins, exactly as the value merge does;
	// only a verbatim false there is the kill switch.
	const named = layers.filter((layer) => layer.enabled !== undefined);
	return { ...resolved, explicitlyDisabled: named.length > 0 && named[named.length - 1]?.enabled === false };
}

/** Parse one provider settings block with environment values taking precedence. */
export function parseCursorCliOauthProviderSettings(
	value: unknown,
	environment: Environment,
): CursorCliOauthProviderSettings {
	return resolveSettings(parseProviderSettings(value), parseEnvironmentSettings(environment));
}

/**
 * Build the probe-owned sandbox allowlist validator without hardcoding modes in settings parsing.
 * Each distinct rejected mode is reported once through the supplied warning hook.
 */
export function createCursorCliOauthSandboxModeValidator(
	acceptedModes: ReadonlySet<string>,
	onWarning: (message: string) => void,
): (value: string | undefined) => string | undefined {
	const warnedModes = new Set<string>();
	return (value) => {
		if (value === undefined || acceptedModes.has(value)) return value;
		if (!warnedModes.has(value)) {
			warnedModes.add(value);
			onWarning(`Ignoring unrecognized Cursor CLI OAuth sandbox mode: ${value}`);
		}
		return undefined;
	};
}

function settingsFingerprint(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

let cachedCursorCliOauthManager: { cwd: string; key: string; manager: SettingsManager } | undefined;

/** Load global and project settings afresh, with env values taking final precedence. */
export function loadCursorCliOauthProviderSettingsFromDisk(cwd: string): CursorCliOauthProviderSettings {
	// fallbackEligible() calls this per candidate probe during retry-fallback; a fresh
	// SettingsManager per call drove locked disk reads hundreds of times per provider
	// error. Cache the manager by (cwd, settings mtime+size) and re-apply env live.
	const agentDir = getAgentDir();
	const key = `${cwd}|${settingsFingerprint(getSettingsPath(cwd, agentDir, "global"))}|${settingsFingerprint(
		getSettingsPath(cwd, agentDir, "project"),
	)}`;
	let settingsManager =
		cachedCursorCliOauthManager?.cwd === cwd && cachedCursorCliOauthManager.key === key
			? cachedCursorCliOauthManager.manager
			: undefined;
	if (!settingsManager) {
		settingsManager = SettingsManager.create(cwd, agentDir);
		cachedCursorCliOauthManager = { cwd, key, manager: settingsManager };
	}
	const global = settingsManager.getGlobalSettings() as SettingsWithCursorCliOauthProvider;
	const project = settingsManager.getProjectSettings() as SettingsWithCursorCliOauthProvider;
	return resolveSettings(
		parseProviderSettings(global.cursorCliOauthProvider),
		parseProviderSettings(project.cursorCliOauthProvider),
		parseEnvironmentSettings(process.env),
	);
}

function persistCursorCliOauthProviderPatch(
	cwd: string,
	action: string,
	patch: Readonly<Record<string, unknown>>,
): void {
	const storage = new FileSettingsStorage(cwd, getAgentDir());
	storage.selectSource("global");
	storage.withLock("global", (current) => {
		let root: Record<string, unknown>;
		try {
			root = current === undefined ? {} : parseSettingsJson(current);
		} catch (error) {
			throw new Error(
				`Cannot persist the cursor-cli-oauth ${action}: the settings file is unparseable (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		const provider =
			typeof root.cursorCliOauthProvider === "object" &&
			root.cursorCliOauthProvider !== null &&
			!Array.isArray(root.cursorCliOauthProvider)
				? { ...(root.cursorCliOauthProvider as Record<string, unknown>) }
				: {};
		return JSON.stringify({ ...root, cursorCliOauthProvider: { ...provider, ...patch } }, null, 2);
	});
}

/** Persist explicit provider activation while preserving every sibling setting. */
export function persistCursorCliOauthEnabled(cwd: string, enabled: boolean): void {
	persistCursorCliOauthProviderPatch(cwd, "enabled state", { enabled });
}

/**
 * Read-modify-write `noApprovalAcknowledgedAt` into the provider block of the
 * global settings file, preserving every other key. An unparseable file is
 * reported instead of silently clobbered, so an acknowledgement can never
 * claim success while leaving the settings unwritten.
 */
export function persistCursorCliNoApprovalAcknowledgement(cwd: string, acknowledgedAt: string): void {
	persistCursorCliOauthProviderPatch(cwd, "acknowledgement", {
		enabled: true,
		noApprovalAcknowledgedAt: acknowledgedAt,
	});
}
