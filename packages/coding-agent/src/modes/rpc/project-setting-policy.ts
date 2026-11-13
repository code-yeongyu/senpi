/**
 * Which project settings `set_project_setting` writes as given, and how it decides every other key.
 *
 * A key on the allowlist is a thinking-level or UI preference; its value is checked against the type the setting
 * declares and written. The thinking-level keys are on it although they change spend: they change only how much one
 * already chosen model thinks. Every other key, a key added later included, and its removal (`null`) alike, is decided
 * as the same write through a tool call would be: an edit of the project settings file plus a shell call only a bash
 * `*` rule decides, by the session's registered permission authorizer, with no ask. The record is decided on the
 * preset its origin calls for (`recordDecisionPreset`); the live service is never reloaded for it, so live rules not
 * loaded with that preset refuse.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import { decideDispatchPolicy, type DispatchPolicy } from "../../core/extensions/builtin/permission-system/dispatch.ts";
import { readDecisionPresetOverride } from "../../core/extensions/builtin/permission-system/preset-registry.ts";
import { recordDecisionPreset } from "../../core/permission-decision.ts";
import { getSettingsPath } from "../../core/settings-manager.ts";
import {
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_PROJECT_SETTING_DENIED,
	RPC_ERROR_PROJECT_SETTING_NEEDS_PERMISSION,
} from "./rpc-error-types.ts";

export interface ProjectSettingRefusal {
	readonly message: string;
	readonly errorCode: string;
}

type ValueCheck = (value: unknown) => boolean;

const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const MODEL_KEY = /^[\x21-\x7e]{1,256}$/;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const oneOf =
	(...allowed: readonly unknown[]): ValueCheck =>
	(value) =>
		allowed.includes(value);
const isBoolean: ValueCheck = (value) => typeof value === "boolean";
const numberFrom =
	(min: number, max: number): ValueCheck =>
	(value) =>
		typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const integerFrom =
	(min: number, max: number): ValueCheck =>
	(value) =>
		Number.isSafeInteger(value) && typeof value === "number" && value >= min && value <= max;

/** A plain object whose own entries are model keys mapped to values `entry` accepts. */
const modelRecordOf =
	(entry: ValueCheck): ValueCheck =>
	(value) =>
		typeof value === "object" &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Object.entries(value).every(([key, item]) => !RESERVED_KEYS.has(key) && MODEL_KEY.test(key) && entry(item));

const thinkingLevel = oneOf(...THINKING_LEVELS);
const MARKDOWN_FIELDS: ReadonlyMap<string, ValueCheck> = new Map<string, ValueCheck>([
	["codeBlockIndent", (value) => typeof value === "string" && /^[ \t]{0,16}$/.test(value)],
	["mermaid", oneOf("off", "final", "streaming")],
]);

/** `markdown`: only its own known fields, an indent of spaces and tabs (no escape sequence reaches the terminal). */
const isMarkdownSettings: ValueCheck = (value) =>
	typeof value === "object" &&
	value !== null &&
	Object.getPrototypeOf(value) === Object.prototype &&
	Object.entries(value).every(([key, item]) => MARKDOWN_FIELDS.get(key)?.(item) === true);

const ALLOWLIST: ReadonlyMap<string, ValueCheck> = new Map<string, ValueCheck>([
	["defaultThinkingLevel", thinkingLevel],
	["modelThinkingLevels", modelRecordOf(thinkingLevel)],
	["modelLastOnThinkingLevels", modelRecordOf(thinkingLevel)],
	["steeringMode", oneOf("all", "one-at-a-time")],
	["followUpMode", oneOf("all", "one-at-a-time")],
	["hideThinkingBlock", isBoolean],
	["smoothStreaming", isBoolean],
	["smoothStreamingFps", numberFrom(30, 120)],
	["showCacheMissNotices", isBoolean],
	["quietStartup", (value) => isBoolean(value) || value === "header"],
	["tips", isBoolean],
	["reducedMotion", isBoolean],
	["collapseChangelog", isBoolean],
	["doubleEscapeAction", oneOf("fork", "tree", "none")],
	["treeFilterMode", oneOf("default", "no-tools", "user-only", "labeled-only", "all")],
	["editorPaddingX", integerFrom(0, 3)],
	["outputPad", oneOf(0, 1)],
	["autocompleteMaxVisible", integerFrom(3, 20)],
	["showHardwareCursor", isBoolean],
	["tuiMode", oneOf("regular", "fullscreen")],
	["fullscreenExitOutput", oneOf("transcript", "resume-hint")],
	["fullscreenScrollbar", oneOf("hidden", "auto", "always")],
	["fullscreenCopyOnSelect", isBoolean],
	["fullscreenWheelScrollLines", (value) => value === "auto" || integerFrom(1, 100)(value)],
	["markdown", isMarkdownSettings],
]);

export interface ProjectSettingWriteCall {
	readonly toolName: "edit" | "bash";
	readonly input: Record<string, unknown>;
}

/** The tool calls a write outside the allowlist is decided as; a bash call without a command is decided as `*`. */
export function projectSettingWriteCalls(settingsPath: string): readonly ProjectSettingWriteCall[] {
	return [
		{ toolName: "edit", input: { path: settingsPath } },
		{ toolName: "bash", input: {} },
	];
}

function stricter(current: DispatchPolicy["action"], next: DispatchPolicy["action"]): DispatchPolicy["action"] {
	if (current === "deny" || next === "deny") return "deny";
	return current === "ask" || next === "ask" ? "ask" : "allow";
}

function denied(reason: string): ProjectSettingRefusal {
	return {
		message: `The session's permission rules refuse writing this project setting: ${reason}`,
		errorCode: RPC_ERROR_PROJECT_SETTING_DENIED,
	};
}

function needsPermission(reason: string): ProjectSettingRefusal {
	return {
		message: `Writing this project setting needs a permission the session would ask for: ${reason}`,
		errorCode: RPC_ERROR_PROJECT_SETTING_NEEDS_PERMISSION,
	};
}

/** The decision for a key outside the allowlist, made synchronously so nothing can change before the write. */
function decideOutsideAllowlist(session: AgentSession): ProjectSettingRefusal | undefined {
	const ctx = session.extensionRunner.createContext();
	const permissionSession = ctx.sessionManager;
	if (permissionSession === undefined) return denied("Permission authorizer is unavailable");
	const settingsPath = getSettingsPath(session.sessionManager.getCwd(), session.agentDir, "project");
	let action: DispatchPolicy["action"] = "allow";
	try {
		for (const [index, call] of projectSettingWriteCalls(settingsPath).entries()) {
			const policy = decideDispatchPolicy(
				permissionSession,
				{
					toolCallId: `set_project_setting-${index}`,
					toolName: call.toolName,
					input: call.input,
					identity: { owner: session, metadata: "set_project_setting" },
				},
				ctx,
			);
			action = stricter(action, policy.action);
		}
	} catch (error) {
		return denied(error instanceof Error ? error.message : String(error));
	}
	if (action === "deny") return denied("a rule denies it.");
	if (action === "ask") return needsPermission("the edit or shell rule asks.");
	// The live rules are this record's only when they were loaded with its preset as the override, the way a turn of
	// the same origin loads them: a preset of the same name from settings keeps the lower settings rules in force.
	const required = recordDecisionPreset(session.sessionManager);
	if (required !== undefined && readDecisionPresetOverride(permissionSession) !== required)
		return needsPermission(`this connection is decided on the ${required} mode.`);
	return undefined;
}

/** Why `set_project_setting` must not write `value` under `key` now, or `undefined` when it may. */
export function refuseProjectSettingWrite(
	session: AgentSession,
	key: string,
	value: unknown,
): ProjectSettingRefusal | undefined {
	const check = ALLOWLIST.get(key);
	if (check === undefined) return decideOutsideAllowlist(session);
	if (value === null || check(value)) return undefined;
	return {
		message: `set_project_setting: ${JSON.stringify(value)} is not a valid value for ${key}.`,
		errorCode: RPC_ERROR_INVALID_ARGUMENT,
	};
}
