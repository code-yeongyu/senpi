import { type ClaudeCliRun, runClaudeCliToExit } from "./claude-cli-process.ts";

/** The local-only profile a CLI-store account shows; never logged or sent to telemetry. */
export type ClaudeCliProfile = {
	readonly email?: string;
	readonly orgName?: string;
	readonly subscriptionType?: string;
};

export type ClaudeCliAuthStatus =
	| { readonly state: "signed_in"; readonly profile: ClaudeCliProfile }
	| { readonly state: "signed_out" }
	/** Logged in, but not as a first-party claude.ai subscription (an API key, Bedrock, Vertex...). */
	| { readonly state: "rejected"; readonly reason: "auth_method" | "api_provider" }
	| { readonly state: "unreadable" };

function stringField(record: Record<string, unknown>, name: string): string | undefined {
	const value = record[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads `claude auth status --json` (2.1.306: `{loggedIn, authMethod, apiProvider, email, orgName,
 * subscriptionType, ...}`, exit 0 when logged in, 1 when not). Only a first-party claude.ai login with exit 0 is
 * signed in; an exit code and a `loggedIn` that disagree are unreadable, never trusted.
 */
export function parseClaudeCliAuthStatus(stdout: string, exitCode: number | null): ClaudeCliAuthStatus {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { state: "unreadable" };
	}
	if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean") return { state: "unreadable" };
	if (!parsed.loggedIn) return exitCode === 0 ? { state: "unreadable" } : { state: "signed_out" };
	if (exitCode !== 0) return { state: "unreadable" };
	if (parsed.authMethod !== "claude.ai") return { state: "rejected", reason: "auth_method" };
	if (parsed.apiProvider !== "firstParty") return { state: "rejected", reason: "api_provider" };
	const email = stringField(parsed, "email");
	const orgName = stringField(parsed, "orgName");
	const subscriptionType = stringField(parsed, "subscriptionType");
	return {
		state: "signed_in",
		profile: {
			...(email === undefined ? {} : { email }),
			...(orgName === undefined ? {} : { orgName }),
			...(subscriptionType === undefined ? {} : { subscriptionType }),
		},
	};
}

export async function readClaudeCliAuthStatus(run: ClaudeCliRun, timeoutMs?: number): Promise<ClaudeCliAuthStatus> {
	const exit = await runClaudeCliToExit(run, ["auth", "status", "--json"], timeoutMs);
	return exit === undefined ? { state: "unreadable" } : parseClaudeCliAuthStatus(exit.stdout, exit.exitCode);
}

/** `claude auth logout` for one account dir: deletes that dir's credential store entry. */
export async function logoutClaudeCli(run: ClaudeCliRun, timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
	const exit = await runClaudeCliToExit(run, ["auth", "logout"], timeoutMs, signal);
	return exit?.exitCode === 0;
}
