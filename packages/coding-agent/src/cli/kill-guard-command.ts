/**
 * The hidden `__kill-guard` subcommand the kill guard's runtime shims call (senpi#5349). Every CLI entry answers it
 * first: the Node launcher (`src/cli.ts`) and the compiled binary's entry (`src/bun/cli.ts`). It loads only the judge,
 * so it never re-executes the runtime, imports the engine, runs a migration or touches the agent dir. The literal is
 * not imported from `check-command.ts` so the judge stays out of every entry's static import graph.
 */
export async function dispatchKillGuardCommand(args: readonly string[]): Promise<void> {
	if (args[0] !== "__kill-guard") return;
	const { runKillGuardCheckCommand } = await import("../core/kill-guard/check-command.ts");
	process.exit(runKillGuardCheckCommand());
}
