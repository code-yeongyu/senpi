import { ENGINE_COMMANDS } from "../../src/engine/metadata.ts";

/**
 * Every option the root command forms accept, generated from the engine's command table, each with a placeholder value
 * when it takes one: a new root option is covered by every row built from this list without an edit.
 */
export function rootFlags(): string[][] {
	const seen = new Map<string, boolean>();
	for (const command of ENGINE_COMMANDS.filter((form) => form.argv.length === 0))
		for (const flag of command.flags) for (const name of flag.names) seen.set(name, flag.takesValue === true);
	return [...seen]
		.filter(([name]) => name.startsWith("-") && name !== "-")
		.map(([name, takesValue]) => (takesValue ? [name, "x"] : [name]));
}
