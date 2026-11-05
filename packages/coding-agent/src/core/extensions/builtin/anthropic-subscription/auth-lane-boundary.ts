import type { CredentialStore } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../../config.ts";
import { AuthStorage } from "../../../auth-storage.ts";
import { type ClaudeCliAuthStatus, readClaudeCliAuthStatus } from "./claude-cli-auth-status.ts";
import { defaultExecutableDeps, resolveClaudeCodeExecutable } from "./executable.ts";

type AuthLaneBoundary = {
	createStore: () => CredentialStore;
	env: () => NodeJS.ProcessEnv;
	getAgentDir: () => string;
	now: () => number;
	/** `claude auth status` for one CLI-store account dir: the auth-block re-probe of a `claude-cli` slot. */
	claudeCliAuthStatus: (configDir: string, env: NodeJS.ProcessEnv) => Promise<ClaudeCliAuthStatus>;
};

const defaultBoundary: AuthLaneBoundary = {
	createStore: () => AuthStorage.create(),
	env: () => process.env,
	getAgentDir,
	now: () => Date.now(),
	claudeCliAuthStatus: (configDir, env) =>
		readClaudeCliAuthStatus({
			executable: resolveClaudeCodeExecutable({ ...defaultExecutableDeps(), env: (key) => env[key] }),
			configDir,
			parentEnv: env,
		}),
};
export let activeBoundary = defaultBoundary;

export function overrideAuthLaneBoundary(override: Partial<AuthLaneBoundary>): void {
	activeBoundary = { ...activeBoundary, ...override };
}

export function resetAuthLaneBoundary(): void {
	activeBoundary = defaultBoundary;
}
