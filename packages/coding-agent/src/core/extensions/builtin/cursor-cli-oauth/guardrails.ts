import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CursorCliOauthExecutionMode, createCursorCliOauthSandboxModeValidator } from "./settings.ts";

/**
 * Guardrails for unattended Cursor CLI execution.
 *
 * The Cursor CLI runs its own tools the moment `--force` is on the argv, so
 * that decision is never implicit: it requires the explicit
 * `noApprovalAcknowledgedAt` acknowledgement, plan mode never forces, and a
 * disabled force merely warns. Command denylists ride along through the
 * per-account HOME's `cli-config.json`, strictly in the probe-proven shape
 * (task 2: `permissions.deny` with exact full-command `Shell(...)` entries).
 */

/** Sandbox modes the installed CLI accepts (task 2 probe: allowed choices are exactly these). */
export const CURSOR_CLI_OAUTH_SANDBOX_MODES: readonly ["enabled", "disabled"] = ["enabled", "disabled"];

export const CURSOR_CLI_OAUTH_NO_APPROVAL_EXPLANATION =
	"The Cursor CLI executes its own tools autonomously: with --force there is no senpi approval, no senpi sandboxing, and no tool-level audit for what it runs.";

export const CURSOR_CLI_OAUTH_ACKNOWLEDGEMENT_STEP =
	'Set "cursorCliOauthProvider.noApprovalAcknowledgedAt" to the current ISO-8601 timestamp (for example "2026-08-17T12:00:00.000Z") in senpi settings to acknowledge this once.';

/** One warning per session when force is disabled in agent mode (contracts block, task 18). */
export const CURSOR_CLI_OAUTH_FORCE_DISABLED_WARNING =
	'cursor-cli-oauth: forceExecution is disabled in agent mode, so the Cursor CLI will auto-reject every tool call; set executionMode to "plan" for planning turns that do not need execution.';

export type CursorCliGuardrailWarningCode =
	| "force_execution_disabled"
	| "sandbox_mode_ignored"
	| "deny_command_rejected";

export type CursorCliGuardrailWarning = {
	readonly kind: "warning";
	readonly code: CursorCliGuardrailWarningCode;
	readonly message: string;
};

export type CursorCliExecutionRefusal = {
	readonly kind: "refusal";
	readonly code: "no_approval_acknowledgement_required";
	readonly message: string;
	readonly acknowledgementStep: string;
};

export type CursorCliGuardrailSession = {
	/** Every warning emitted so far in this session; one-time gates live here. */
	readonly warnings: readonly CursorCliGuardrailWarning[];
	/** Emit a warning once per deduplication key; returns whether it was emitted. */
	warn(code: CursorCliGuardrailWarningCode, message: string, key?: string): boolean;
	/** Validate a sandbox mode against the probe-proven allowlist, warning once per rejected value. */
	validateSandboxMode(value: string | undefined): string | undefined;
};

export function createCursorCliGuardrailSession(): CursorCliGuardrailSession {
	const warnings: CursorCliGuardrailWarning[] = [];
	const emitted = new Set<string>();
	const warn = (code: CursorCliGuardrailWarningCode, message: string, key: string = code): boolean => {
		if (emitted.has(key)) return false;
		emitted.add(key);
		warnings.push({ kind: "warning", code, message });
		return true;
	};
	const validateSandboxMode = createCursorCliOauthSandboxModeValidator(
		new Set(CURSOR_CLI_OAUTH_SANDBOX_MODES),
		(message) => {
			warn("sandbox_mode_ignored", message, `sandbox_mode_ignored:${message}`);
		},
	);
	return {
		warnings,
		warn,
		validateSandboxMode,
	};
}

export type CursorCliExecutionPolicyInput = {
	readonly forceExecution: boolean;
	readonly noApprovalAcknowledgedAt: string | undefined;
	readonly executionMode: CursorCliOauthExecutionMode;
	readonly sandboxMode: string | undefined;
};

export type CursorCliExecutionDecision =
	| { readonly status: "refused"; readonly refusal: CursorCliExecutionRefusal }
	| {
			readonly status: "allowed";
			readonly force: boolean;
			readonly executionMode: CursorCliOauthExecutionMode;
			readonly sandboxMode: string | undefined;
			readonly denyCommands: readonly string[];
			/** Warnings accumulated in the session so far (not only this decision). */
			readonly warnings: readonly CursorCliGuardrailWarning[];
	  };

/** Typed refusal for an unacknowledged force attempt; never confused with a warning. */
export class CursorCliExecutionRefusalError extends Error {
	readonly code = "no_approval_acknowledgement_required" as const;
	readonly refusal: CursorCliExecutionRefusal;

	constructor(refusal: CursorCliExecutionRefusal) {
		super(refusal.message);
		this.name = "CursorCliExecutionRefusalError";
		this.refusal = refusal;
	}
}

/** Glob breadth is unproven (task 2 probed exact full commands only), so glob-bearing entries are dropped. */
const GLOB_METACHARACTERS = /[*?[]/u;

export function sanitizeCursorCliDenyCommands(
	entries: readonly string[],
	warn?: (message: string) => void,
): readonly string[] {
	const kept: string[] = [];
	for (const entry of entries) {
		const command = entry.trim();
		if (command.length === 0) {
			warn?.("Ignoring an empty Cursor CLI deny command entry (exact full commands only)");
			continue;
		}
		if (GLOB_METACHARACTERS.test(command)) {
			warn?.(
				`Ignoring glob-bearing Cursor CLI deny command (exact full commands only; glob support is unproven): ${command}`,
			);
			continue;
		}
		kept.push(command);
	}
	return kept;
}

/**
 * Decide whether a turn may run unattended.
 *
 * - `--force` is emitted only in agent mode, only when force is requested, and
 *   only after `noApprovalAcknowledgedAt` is set; otherwise the decision is a
 *   typed refusal naming the acknowledgement step.
 * - Plan mode never emits `--force` (the CLI only plans), so it needs no
 *   acknowledgement.
 * - Force disabled in agent mode is allowed but warns once per session.
 * - Unproven sandbox modes are ignored with one warning per distinct value.
 */
export function resolveCursorCliExecutionPolicy(
	input: CursorCliExecutionPolicyInput,
	session: CursorCliGuardrailSession,
	denyCommands: readonly string[] = [],
): CursorCliExecutionDecision {
	const planMode = input.executionMode === "plan";
	const wantsForce = !planMode && input.forceExecution;
	if (wantsForce && input.noApprovalAcknowledgedAt === undefined) {
		const refusal: CursorCliExecutionRefusal = {
			kind: "refusal",
			code: "no_approval_acknowledgement_required",
			message: `${CURSOR_CLI_OAUTH_NO_APPROVAL_EXPLANATION} ${CURSOR_CLI_OAUTH_ACKNOWLEDGEMENT_STEP}`,
			acknowledgementStep: CURSOR_CLI_OAUTH_ACKNOWLEDGEMENT_STEP,
		};
		return { status: "refused", refusal };
	}
	if (!planMode && !input.forceExecution) {
		session.warn("force_execution_disabled", CURSOR_CLI_OAUTH_FORCE_DISABLED_WARNING);
	}
	const sandboxMode = session.validateSandboxMode(input.sandboxMode);
	const sanitizedDenyCommands = sanitizeCursorCliDenyCommands(denyCommands, (message) => {
		session.warn("deny_command_rejected", message, `deny_command_rejected:${message}`);
	});
	return {
		status: "allowed",
		force: wantsForce,
		executionMode: input.executionMode,
		sandboxMode,
		denyCommands: sanitizedDenyCommands,
		warnings: [...session.warnings],
	};
}

const CLI_CONFIG_RELATIVE_PATH = join(".cursor", "cli-config.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellDenyEntry(command: string): string {
	return `Shell(${command})`;
}

/**
 * Pre-spawn hook: (re-)apply the deny list to the sandbox HOME's
 * `cli-config.json`.
 *
 * The CLI rewrites this file during every invocation (task 2 observed its own
 * keys appearing and `cli-config.json.bad` sidecars for malformed content), so
 * this must run immediately before each spawn, composing with the home-store
 * prepare pass that re-writes `auth.json` on the same cadence. Writes only the
 * probe-proven shape (`permissions.deny` with exact `Shell(<full command>)`
 * entries) and preserves every CLI-owned key already present. Writes nothing
 * when no deny commands are configured.
 */
export function applyCursorCliDenyConfig(home: string, denyCommands: readonly string[]): void {
	if (denyCommands.length === 0) return;
	const configPath = join(home, CLI_CONFIG_RELATIVE_PATH);
	let existing: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			if (isRecord(parsed)) existing = parsed;
		} catch {
			// The CLI quarantines unparseable config as cli-config.json.bad and
			// proceeds with defaults; start from the proven minimal shape.
		}
	}
	const permissions = isRecord(existing.permissions) ? { ...existing.permissions } : {};
	const config: Record<string, unknown> = {
		...existing,
		permissions: { ...permissions, deny: denyCommands.map(shellDenyEntry) },
	};
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}
