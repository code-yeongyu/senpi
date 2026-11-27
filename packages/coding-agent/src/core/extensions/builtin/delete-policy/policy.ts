/**
 * The `deletePolicy` setting (omo#11072): how deletes an agent asks for are handled.
 *
 * - `trash` (default, every permission preset included): deletes go to the trash; an explicit
 *   permanent delete needs a reason and is audited.
 * - `trash-only`: the same, but a model's permanent-delete request is refused.
 * - `log-only`: permanent deletes, still audited. The default when `CI` is set, since CI runners
 *   are ephemeral and disk-bound.
 *
 * This module only defines and reads the setting; the enforcement points (engine cleanups, shell
 * interception) consume it in later changes. `retentionDays` and `maxTrashBytes` bound the
 * freedesktop-layout trash and are enforced on every trash write and by `senpi trash empty`.
 *
 * `macosTrash` picks the macOS backend. `fast` (default) is that same freedesktop-layout trash, a
 * same-volume rename that takes milliseconds. `os` is the Finder Trash through `/usr/bin/trash`, which
 * cost 35-38 s per call from a background session on macOS 26, with no saving from batching
 * (senpi#7578), so it is an opt-in.
 */

export const DELETE_POLICY_MODES = ["trash", "trash-only", "log-only"] as const;
export type DeletePolicyMode = (typeof DELETE_POLICY_MODES)[number];

export const MACOS_TRASH_BACKENDS = ["fast", "os"] as const;
export type MacosTrashBackend = (typeof MACOS_TRASH_BACKENDS)[number];

export const AUTO_TRASH_SHARE = 0.15;
export const DEFAULT_RETENTION_DAYS = 14;

export interface DeletePolicy {
	readonly mode: DeletePolicyMode;
	readonly retentionDays: number;
	/** A byte count, or `auto` (15% of the volume that holds the trash). */
	readonly maxTrashBytes: number | "auto";
	readonly macosTrash: MacosTrashBackend;
}

export class DeletePolicySettingError extends Error {
	constructor(message: string) {
		super(`Invalid deletePolicy setting: ${message}`);
		this.name = "DeletePolicySettingError";
	}
}

function isCi(env: NodeJS.ProcessEnv): boolean {
	const value = env.CI?.trim().toLowerCase();
	return value === "true" || value === "1";
}

function parseMode(value: unknown): DeletePolicyMode | undefined {
	if (value === undefined) return undefined;
	const mode = DELETE_POLICY_MODES.find((candidate) => candidate === value);
	if (mode === undefined) {
		throw new DeletePolicySettingError(
			`mode ${JSON.stringify(value)} is not one of ${DELETE_POLICY_MODES.join(", ")}.`,
		);
	}
	return mode;
}

function parseRetentionDays(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new DeletePolicySettingError(
			`retentionDays must be an integer of at least 1, got ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

function parseMacosTrash(value: unknown): MacosTrashBackend | undefined {
	if (value === undefined) return undefined;
	const backend = MACOS_TRASH_BACKENDS.find((candidate) => candidate === value);
	if (backend === undefined) {
		throw new DeletePolicySettingError(
			`macosTrash ${JSON.stringify(value)} is not one of ${MACOS_TRASH_BACKENDS.join(", ")}.`,
		);
	}
	return backend;
}

function parseMaxTrashBytes(value: unknown): number | "auto" | undefined {
	if (value === undefined || value === "auto") return value;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new DeletePolicySettingError(
			`maxTrashBytes must be "auto" or a positive integer byte count, got ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

/**
 * Resolve the policy from the effective (already merged) settings object. An explicit `mode` wins;
 * without one, `CI=true` selects `log-only` and everything else `trash`.
 */
export function resolveDeletePolicy(settings: object, env: NodeJS.ProcessEnv = process.env): DeletePolicy {
	const raw: unknown = Reflect.get(settings, "deletePolicy");
	if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
		throw new DeletePolicySettingError("expected an object with mode, retentionDays and maxTrashBytes.");
	}
	const field = (key: string): unknown => (raw === undefined ? undefined : Reflect.get(raw, key));
	return {
		mode: parseMode(field("mode")) ?? (isCi(env) ? "log-only" : "trash"),
		retentionDays: parseRetentionDays(field("retentionDays")) ?? DEFAULT_RETENTION_DAYS,
		maxTrashBytes: parseMaxTrashBytes(field("maxTrashBytes")) ?? "auto",
		macosTrash: parseMacosTrash(field("macosTrash")) ?? "fast",
	};
}
