import type { SettingsManager, TerminalSettings } from "../../../settings-manager.ts";
import {
	DEFAULT_COLS,
	DEFAULT_MAX_SESSIONS,
	DEFAULT_MONITOR_RUNAWAY_LINES_PER_MINUTE,
	DEFAULT_MONITOR_RUNAWAY_MINUTES,
	DEFAULT_MONITOR_WAKES_PER_HOUR,
	DEFAULT_ROWS,
	DEFAULT_SCROLLBACK,
} from "./shared.ts";

export type TimeoutAction = "background" | "kill";
export type NotifyMode = "wake" | "next-turn" | "off";

export interface MonitorDeliverySettings {
	readonly coalesceWindowMs: number;
	readonly rateLimitMs: number;
	readonly maxLinesPerInjection: number;
	readonly maxCharsPerInjection: number;
	readonly wakeBudget: number;
	/** Average wakes an hour (and burst size) of a persistent command watch; more lines batch. */
	readonly wakesPerHour: number;
}

/** Runaway guard of a persistent command watch: pause after this many lines a minute for this many minutes. */
export interface MonitorRunawayGuard {
	readonly linesPerMinute: number;
	readonly minutes: number;
}

export interface ResolvedTerminalSettings {
	readonly redactSecretsInOutput?: boolean;
	readonly defaultCols: number;
	readonly defaultRows: number;
	readonly scrollback: number;
	readonly maxSessions: number;
	readonly timeoutAction: TimeoutAction;
	readonly notify: NotifyMode;
	readonly monitor: MonitorDeliverySettings;
	readonly monitorRunaway: MonitorRunawayGuard;
	/** Admission cap on persistent (restart-surviving) monitors per session. */
	readonly maxDurableMonitors: number | "unlimited";
}

export const TERMINAL_SETTINGS_DEFAULTS: ResolvedTerminalSettings = {
	redactSecretsInOutput: false,
	defaultCols: DEFAULT_COLS,
	defaultRows: DEFAULT_ROWS,
	scrollback: DEFAULT_SCROLLBACK,
	maxSessions: DEFAULT_MAX_SESSIONS,
	timeoutAction: "background",
	notify: "wake",
	monitor: {
		coalesceWindowMs: 2000,
		rateLimitMs: 5000,
		maxLinesPerInjection: 50,
		maxCharsPerInjection: 4096,
		wakeBudget: 5,
		wakesPerHour: DEFAULT_MONITOR_WAKES_PER_HOUR,
	},
	monitorRunaway: {
		linesPerMinute: DEFAULT_MONITOR_RUNAWAY_LINES_PER_MINUTE,
		minutes: DEFAULT_MONITOR_RUNAWAY_MINUTES,
	},
	maxDurableMonitors: "unlimited",
};

/** Upper bound of a wake rate (setting or per-monitor override): one wake a second on average. */
export const MAX_MONITOR_WAKES_PER_HOUR = 3600;

function positiveInt(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.trunc(value), maximum);
}

function nonNegativeInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return Math.trunc(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A positive integer caps durable monitors; anything else, including "unlimited", means no cap. */
function durableMonitorCap(value: unknown): number | "unlimited" {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return "unlimited";
	return Math.trunc(value);
}

/** Resolve terminal-tool config from a raw `terminal` settings block, filling defaults. */
export function resolveTerminalSettings(raw: TerminalSettings | undefined): ResolvedTerminalSettings {
	if (!raw) return TERMINAL_SETTINGS_DEFAULTS;
	return {
		defaultCols: positiveInt(raw.defaultCols, TERMINAL_SETTINGS_DEFAULTS.defaultCols),
		defaultRows: positiveInt(raw.defaultRows, TERMINAL_SETTINGS_DEFAULTS.defaultRows),
		scrollback: nonNegativeInt(raw.scrollback, TERMINAL_SETTINGS_DEFAULTS.scrollback),
		maxSessions: positiveInt(raw.maxSessions, TERMINAL_SETTINGS_DEFAULTS.maxSessions),
		timeoutAction: oneOf(raw.timeoutAction, ["background", "kill"], TERMINAL_SETTINGS_DEFAULTS.timeoutAction),
		notify: oneOf(raw.notify, ["wake", "next-turn", "off"], TERMINAL_SETTINGS_DEFAULTS.notify),
		monitor: {
			coalesceWindowMs: positiveInt(
				raw.monitorCoalesceWindowMs,
				TERMINAL_SETTINGS_DEFAULTS.monitor.coalesceWindowMs,
				60_000,
			),
			rateLimitMs: positiveInt(raw.monitorRateLimitMs, TERMINAL_SETTINGS_DEFAULTS.monitor.rateLimitMs, 3_600_000),
			maxLinesPerInjection: positiveInt(
				raw.monitorMaxLinesPerInjection,
				TERMINAL_SETTINGS_DEFAULTS.monitor.maxLinesPerInjection,
				200,
			),
			maxCharsPerInjection: positiveInt(
				raw.monitorMaxCharsPerInjection,
				TERMINAL_SETTINGS_DEFAULTS.monitor.maxCharsPerInjection,
				16_384,
			),
			wakeBudget: positiveInt(raw.monitorWakeBudget, TERMINAL_SETTINGS_DEFAULTS.monitor.wakeBudget, 100),
			wakesPerHour: positiveInt(
				raw.monitorWakesPerHour,
				TERMINAL_SETTINGS_DEFAULTS.monitor.wakesPerHour,
				MAX_MONITOR_WAKES_PER_HOUR,
			),
		},
		monitorRunaway: {
			linesPerMinute: positiveInt(
				raw.monitorRunawayLinesPerMinute,
				TERMINAL_SETTINGS_DEFAULTS.monitorRunaway.linesPerMinute,
			),
			minutes: positiveInt(raw.monitorRunawayMinutes, TERMINAL_SETTINGS_DEFAULTS.monitorRunaway.minutes, 1440),
		},
		maxDurableMonitors: durableMonitorCap(raw.maxDurableMonitors),
	};
}

/** Load and merge terminal-tool settings from global + project settings.json. */
export function loadTerminalSettings(settingsManager: SettingsManager): ResolvedTerminalSettings {
	const global = settingsManager.getGlobalSettings().terminal;
	const project = settingsManager.getProjectSettings().terminal;
	const merged: TerminalSettings = { ...global, ...project };
	return {
		...resolveTerminalSettings(merged),
		redactSecretsInOutput: settingsManager.getBashRedactSecretsInOutput(),
	};
}
