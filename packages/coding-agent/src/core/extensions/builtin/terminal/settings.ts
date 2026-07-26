import type { SettingsManager, TerminalSettings } from "../../../settings-manager.ts";
import { DEFAULT_COLS, DEFAULT_MAX_SESSIONS, DEFAULT_ROWS, DEFAULT_SCROLLBACK } from "./shared.ts";

export type TimeoutAction = "background" | "kill";
export type NotifyMode = "wake" | "next-turn" | "off";

export interface MonitorDeliverySettings {
	readonly coalesceWindowMs: number;
	readonly rateLimitMs: number;
	readonly maxLinesPerInjection: number;
	readonly maxCharsPerInjection: number;
	readonly wakeBudget: number;
}

export interface ResolvedTerminalSettings {
	readonly defaultCols: number;
	readonly defaultRows: number;
	readonly scrollback: number;
	readonly maxSessions: number;
	readonly timeoutAction: TimeoutAction;
	readonly notify: NotifyMode;
	readonly monitor: MonitorDeliverySettings;
}

export const TERMINAL_SETTINGS_DEFAULTS: ResolvedTerminalSettings = {
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
	},
};

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
		},
	};
}

/** Load and merge terminal-tool settings from global + project settings.json. */
export function loadTerminalSettings(settingsManager: SettingsManager): ResolvedTerminalSettings {
	const global = settingsManager.getGlobalSettings().terminal;
	const project = settingsManager.getProjectSettings().terminal;
	const merged: TerminalSettings = { ...global, ...project };
	return resolveTerminalSettings(merged);
}
