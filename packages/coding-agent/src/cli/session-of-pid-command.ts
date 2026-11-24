import { APP_NAME } from "../config.ts";
import { resolvePidSession } from "../core/session-spawn-attestation.ts";
import { exitAfterOutput } from "./print-then-exit.ts";

/**
 * `session-of-pid <pid> --json` (senpi#6972): which session spawned `pid`, from the kernel's ancestry and the spawning
 * engine's records under this agent directory, never from an environment. One version-1 JSON record; exit 0 when
 * the pid is attested, 1 when it is not, 2 on invalid arguments. A metadata command: it starts no host and writes
 * nothing.
 */
export async function dispatchSessionOfPidCommand(args: readonly string[]): Promise<void> {
	if (args[0] !== "session-of-pid") return;
	const pid = Number(args[1]);
	if (args.length !== 3 || args[2] !== "--json" || !Number.isInteger(pid) || pid <= 0) {
		await exitAfterOutput(
			`${JSON.stringify({
				version: 1,
				ok: false,
				code: "invalid_arguments",
				message: `Usage: ${APP_NAME} session-of-pid <pid> --json`,
			})}\n`,
			2,
		);
		return;
	}
	const answer = await resolvePidSession(pid);
	await exitAfterOutput(`${JSON.stringify({ version: 1, ok: true, ...answer })}\n`, answer.attested ? 0 : 1);
}
