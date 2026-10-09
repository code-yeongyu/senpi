/**
 * Node entry point for the Claude Code version cache.
 *
 * `claude-code-version.ts` is browser-safe and keeps no state on disk. Hosts with a filesystem
 * call `installClaudeCodeVersionFileStore()` once at startup so the resolved version survives
 * process restarts and one lookup per six hours serves every session on the machine.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type CachedClaudeCodeVersion,
	type ClaudeCodeVersionStore,
	installClaudeCodeVersionStore,
} from "./claude-code-version.ts";

const CACHE_FILE = "claude-code-version.json";

/** Same resolution as the other pi-ai stores: the agent directory the host configured, then the default one. */
export function resolveClaudeCodeVersionCachePath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir =
		env.SENPI_CODING_AGENT_DIR ?? env.CODING_AGENT_DIR ?? `${(env.HOME ?? ".").replace(/\/$/, "")}/.senpi/agent`;
	return `${agentDir.replace(/\/$/, "")}/${CACHE_FILE}`;
}

function isCachedVersion(value: unknown): value is CachedClaudeCodeVersion {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { version?: unknown }).version === "string" &&
		typeof (value as { checkedAt?: unknown }).checkedAt === "number"
	);
}

export function createClaudeCodeVersionFileStore(path: string): ClaudeCodeVersionStore {
	let savingEnabled = true;
	return {
		load: () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				// No file on first run, and a truncated or hand-edited one is the same situation
				// for a cache: the bundled floor is the documented fallback.
				return undefined;
			}
			return isCachedVersion(parsed) ? parsed : undefined;
		},
		save: (record) => {
			if (!savingEnabled) return;
			try {
				mkdirSync(dirname(path), { recursive: true });
				const temporaryPath = `${path}.${process.pid}.tmp`;
				writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`);
				renameSync(temporaryPath, path);
			} catch {
				// A read-only agent directory must not fail the live request, and one failure
				// disables saving so a broken path cannot cost a write per refresh.
				savingEnabled = false;
			}
		},
	};
}

export interface InstallClaudeCodeVersionFileStoreOptions {
	/** Cache file; defaults to `<agent dir>/claude-code-version.json`. */
	readonly path?: string;
	/** Serve the cache but never fetch (host offline mode); defaults to `PI_OFFLINE`. */
	readonly offline?: boolean;
}

export function installClaudeCodeVersionFileStore(options: InstallClaudeCodeVersionFileStoreOptions = {}): void {
	const env = process.env;
	const offline = options.offline ?? (env.PI_OFFLINE !== undefined && env.PI_OFFLINE !== "" && env.PI_OFFLINE !== "0");
	installClaudeCodeVersionStore(
		createClaudeCodeVersionFileStore(options.path ?? resolveClaudeCodeVersionCachePath(env)),
		{ offline },
	);
}
