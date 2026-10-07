import type { HookSourceScope, HookTrustEntry, HookTrustState } from "./types.ts";

const HOOK_STATE_VERSION = 1;

export function emptyHookTrustState(): HookTrustState {
	return { version: HOOK_STATE_VERSION, hooks: {} };
}

export function parseHookTrustStateJson(input: string | undefined): HookTrustState | undefined {
	if (input === undefined || input.trim() === "") {
		return undefined;
	}
	try {
		return parseHookTrustState(JSON.parse(input));
	} catch (error) {
		if (error instanceof SyntaxError) {
			return undefined;
		}
		throw error;
	}
}

export function readHookTrustStateJson(input: string | undefined): HookTrustState {
	return parseHookTrustStateJson(input) ?? emptyHookTrustState();
}

function parseHookTrustState(input: unknown): HookTrustState | undefined {
	if (!isRecord(input) || input.version !== HOOK_STATE_VERSION || !isRecord(input.hooks)) {
		return undefined;
	}

	const hooks: Record<string, HookTrustEntry> = {};
	for (const [id, entry] of Object.entries(input.hooks)) {
		const parsed = parseHookTrustEntry(entry);
		if (parsed !== undefined) {
			hooks[id] = parsed;
		}
	}
	return { version: HOOK_STATE_VERSION, hooks };
}

function parseHookTrustEntry(input: unknown): HookTrustEntry | undefined {
	if (!isRecord(input)) {
		return undefined;
	}
	const enabled = input.enabled;
	const trustedHash = input.trustedHash;
	const scope = input.scope;
	const sourcePath = input.sourcePath;
	const matcher = input.matcher;
	const commandPreview = input.commandPreview;
	const updatedAt = input.updatedAt;
	if (
		typeof enabled !== "boolean" ||
		(trustedHash !== undefined && typeof trustedHash !== "string") ||
		!isHookSourceScope(scope) ||
		typeof sourcePath !== "string" ||
		(matcher !== undefined && typeof matcher !== "string") ||
		typeof commandPreview !== "string" ||
		typeof updatedAt !== "string"
	) {
		return undefined;
	}
	return {
		enabled,
		...(trustedHash === undefined ? {} : { trustedHash }),
		scope,
		sourcePath,
		...(matcher === undefined ? {} : { matcher }),
		commandPreview,
		updatedAt,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookSourceScope(value: unknown): value is HookSourceScope {
	return (
		value === "global" ||
		value === "project" ||
		value === "plugin" ||
		value === "runtime" ||
		value === "cli" ||
		value === "managed"
	);
}
