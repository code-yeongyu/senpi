import { assertValidSessionId } from "../core/session-manager.ts";
import type { Args } from "./args.ts";

function conflicts(label: string, flags: readonly (readonly [unknown, string])[]): string | undefined {
	const named = flags.filter(([present]) => Boolean(present)).map(([, name]) => name);
	return named.length > 0 ? `${label} cannot be combined with ${named.join(", ")}` : undefined;
}

/**
 * The refusals a launch meets after its arguments parse and before any session opens, in the order the CLI
 * applies them; `main()` prints the message and exits 1, a launch function answers it before spawning.
 */
export function sessionFlagRefusal(parsed: Args): string | undefined {
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) return "@file arguments are not supported in RPC mode";
	const fork = parsed.fork
		? conflicts("--fork", [
				[parsed.session, "--session"],
				[parsed.continue, "--continue"],
				[parsed.resume, "--resume"],
				[parsed.noSession, "--no-session"],
			])
		: undefined;
	if (fork !== undefined) return fork;
	const rebind = parsed.rebind
		? conflicts("--rebind", [
				[parsed.session, "--session"],
				[parsed.fork, "--fork"],
				[parsed.continue, "--continue"],
				[parsed.resume, "--resume"],
				[parsed.noSession, "--no-session"],
				[parsed.sessionId !== undefined, "--session-id"],
			])
		: undefined;
	if (rebind !== undefined) return rebind;
	if (parsed.sessionId === undefined) return undefined;
	const sessionId = conflicts("--session-id", [
		[parsed.session, "--session"],
		[parsed.continue, "--continue"],
		[parsed.resume, "--resume"],
	]);
	if (sessionId !== undefined) return sessionId;
	try {
		assertValidSessionId(parsed.sessionId);
		return undefined;
	} catch (error: unknown) {
		return error instanceof Error ? error.message : String(error);
	}
}
