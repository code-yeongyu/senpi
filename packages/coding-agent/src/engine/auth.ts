/**
 * `engine.auth` (security design 4.3, 5.5). `check` answers status only. The three provider-credential
 * operations export their input and their refusals and no way to receive the value: a provider credential goes
 * only to the destinations of the custody matrix, which this build does not deliver to, so each refuses after
 * the input checks the command applies and before the credential store is read.
 */
import { type Args, parseArgs } from "../cli/args.ts";
import { type AuthCheckResult, runAuthCheck } from "../cli/auth-check.ts";
import {
	type AuthCommand,
	type AuthCommandKind,
	parseAuthCommand,
	validateAuthCommandArgs,
} from "../cli/auth-command.ts";
import type { CredentialAccountSummary } from "../core/credential-accounts.ts";
import { commandArgv } from "./launch-argv.ts";
import { AUTH_COMMANDS } from "./metadata-auth.ts";
import { type EngineError, type EngineResult, engineError, engineOk } from "./result.ts";

export interface AuthTargetInput {
	readonly provider?: string;
	readonly model?: string;
}

export interface AuthCheckInput extends AuthTargetInput {
	/** Refresh an expired OAuth credential, which writes the auth store; the command's default is to refresh. */
	readonly refresh?: boolean;
}

export interface AuthCredentialsInput extends AuthTargetInput {
	readonly refresh?: boolean;
}

export interface AuthBearerTokenInput extends AuthTargetInput {
	readonly min_expiry_ms?: number;
}

export type AuthStatus = Readonly<AuthCheckResult> & { readonly accounts: readonly CredentialAccountSummary[] };

export type AuthCheckCode = "invalid_input";
/** `delivery_unavailable`: no destination the custody matrix allows is delivered to by this build. */
export type AuthCredentialCode = "invalid_input" | "delivery_unavailable";

const DELIVERY_UNAVAILABLE =
	"A provider credential is delivered only to an admitted terminal or to the named peer, and this build delivers it to neither. Give a key to an engine process with the launch input api_key.";

function commandOf(call: string) {
	const command = AUTH_COMMANDS.find((entry) => entry.call === call);
	if (command === undefined) throw new Error(`no auth metadata for ${call}`);
	return command;
}

/** The command's own parse of the same input: its argv, its usage refusals, and the parser's. */
function parseAuth(call: string, input: unknown): { readonly command: AuthCommand; readonly parsed: Args } | string {
	try {
		const command = parseAuthCommand(commandArgv(commandOf(call), input));
		if (command === undefined) return `no auth command for ${call}`;
		const parsed = parseArgs(command.args);
		const unknown = parsed.unknownFlags.keys().next().value;
		if (unknown !== undefined) return `Unknown option --${unknown}`;
		if (parsed.diagnostics.length > 0) return parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
		return { command, parsed };
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
}

export async function checkAuth(input: AuthCheckInput): Promise<EngineResult<AuthStatus, AuthCheckCode>> {
	const read = parseAuth("auth.check", input);
	if (typeof read === "string") return engineError("invalid_input", read);
	try {
		const { result, accounts = [] } = await runAuthCheck(read.parsed, {
			refresh: !read.command.noRefresh,
			json: true,
			credential: false,
		});
		return engineOk({ ...result, accounts });
	} catch (error: unknown) {
		return engineError("invalid_input", error instanceof Error ? error.message : String(error));
	}
}

function refuseDelivery(call: string, kind: AuthCommandKind, input: unknown): EngineError<AuthCredentialCode> {
	const read = parseAuth(call, input);
	if (typeof read === "string") return engineError("invalid_input", read);
	try {
		validateAuthCommandArgs(read.parsed, kind);
	} catch (error: unknown) {
		return engineError("invalid_input", error instanceof Error ? error.message : String(error));
	}
	return engineError("delivery_unavailable", DELIVERY_UNAVAILABLE);
}

export async function credentials(input: AuthCredentialsInput): Promise<EngineError<AuthCredentialCode>> {
	return refuseDelivery("auth.credentials", "check", input);
}

export async function apiKey(input: AuthTargetInput): Promise<EngineError<AuthCredentialCode>> {
	return refuseDelivery("auth.apiKey", "api_key", input);
}

export async function bearerToken(input: AuthBearerTokenInput): Promise<EngineError<AuthCredentialCode>> {
	return refuseDelivery("auth.bearerToken", "bearer_token", input);
}
