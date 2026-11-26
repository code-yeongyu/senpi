import { ENGINE_COMMANDS } from "../engine/metadata.ts";

/**
 * Whether an invocation may read the private descriptor table (security design B10). `reads_table`: it can start a
 * session, a host or the supervisor, so an unparsed table refuses it. `no_session`: it cannot, so it never reads the
 * table and a person can still diagnose a broken one.
 */
export type InvocationClass = "reads_table" | "no_session";

/**
 * Every command form of the engine's command table, classified. A form missing here reads the table (default
 * refuse); a test enumerates the command table so a new form cannot ship unclassified.
 */
export interface InvocationRow {
	readonly kind: InvocationClass;
	readonly reason: string;
}

export const INVOCATION_CLASSES: Readonly<Record<string, InvocationRow>> = {
	tips: { kind: "no_session", reason: "prints the bundled tips" },
	"config.agentDir": { kind: "no_session", reason: "prints a path" },
	sessionOfPid: { kind: "no_session", reason: "looks up a running session's file" },
	"host.status": { kind: "no_session", reason: "reads a running host's state" },
	"host.stop": { kind: "no_session", reason: "stops a host, starts nothing" },
	"auth.check": { kind: "reads_table", reason: "uses a provider credential" },
	"auth.credentials": { kind: "reads_table", reason: "uses a provider credential" },
	"auth.apiKey": { kind: "reads_table", reason: "uses a provider credential" },
	"auth.bearerToken": { kind: "reads_table", reason: "uses a provider credential" },
	"launch.interactive": { kind: "reads_table", reason: "starts a session" },
	"launch.print": { kind: "reads_table", reason: "starts a session" },
	"launch.rpc": { kind: "reads_table", reason: "starts a session" },
	"launch.hand": { kind: "reads_table", reason: "starts a session" },
	"launch.headless": { kind: "reads_table", reason: "starts a session" },
	"packages.install": { kind: "no_session", reason: "installs a package: no credential, no start" },
	"packages.remove": { kind: "no_session", reason: "removes a package: no credential, no start" },
	"packages.list": { kind: "no_session", reason: "lists packages: no credential, no start" },
	"packages.update": { kind: "no_session", reason: "updates packages: no credential, no start" },
	"models.update": { kind: "reads_table", reason: "uses a provider credential (owner ruling D22-18)" },
	"models.discover": { kind: "reads_table", reason: "uses a provider credential" },
	"models.list": {
		kind: "reads_table",
		reason: "starts no session; refuses by choice: resolves models with their credentials",
	},
	"config.resources": { kind: "no_session", reason: "the config selector: no credential, no start" },
	"config.setResource": { kind: "no_session", reason: "the config selector: no credential, no start" },
	"schedule.list": { kind: "no_session", reason: "lists scheduled jobs: no credential, no start" },
	"schedule.cancel": { kind: "no_session", reason: "removes a scheduled job: no credential, no start" },
	"schedule.run": { kind: "reads_table", reason: "a scheduled run is judged when it starts its session" },
	"sessions.exportHtml": { kind: "reads_table", reason: "default refuse: opens session state" },
	promptSizes: {
		kind: "reads_table",
		reason: "starts no session; refuses by choice: builds a session's prompt and its models",
	},
	"host.ensure": { kind: "reads_table", reason: "starts a host" },
	"host.handoff": { kind: "reads_table", reason: "starts a host" },
	"host.gc": { kind: "reads_table", reason: "default refuse: manages host state" },
	"host.shardPath": { kind: "reads_table", reason: "default refuse: manages host state" },
};

/** Help and version exempt only as the first argument: anywhere later the command decides (owner ruling). */
const FIRST_ONLY: ReadonlySet<string> = new Set(["--help", "-h", "--version", "-v"]);

function startsWith(args: readonly string[], words: readonly string[]): boolean {
	return words.every((word, index) => args[index] === word);
}

/**
 * Whether `options` names this command form. Subcommand words and the first token are always read as such by the
 * parser; any later token may be an option's value (`--system-prompt --list-tips`). So a root flag exempts only as the
 * first token, and anywhere else a token can only move an invocation toward reading the table, never away from it.
 */
function names(
	argv: readonly string[],
	required: readonly (readonly string[])[],
	flagsGiven: boolean,
	kind: InvocationClass,
	options: readonly string[],
): boolean {
	if (argv.length > 0) return startsWith(options, argv);
	if (required.length === 0 || !flagsGiven) return false;
	return kind === "reads_table" || (required.length === 1 && (required[0] ?? []).includes(options[0] ?? ""));
}

/**
 * The class of `args`: help and version exempt only as the first argument; options end at `--`. Otherwise the most specific command form that matches decides
 * (subcommand words plus the required flags given, or for a root form its required flag); a tie is exempt only if every tied form is.
 */
export function classifyInvocation(args: readonly string[]): InvocationClass {
	if (FIRST_ONLY.has(args[0] ?? "")) return "no_session";
	const end = args.indexOf("--");
	const options = end === -1 ? args : args.slice(0, end);
	// main() takes the attach branch before the tips branch, so an attach always reads the table (review 6069794971).
	if (options.includes("--attach")) return "reads_table";
	let best = Number.NEGATIVE_INFINITY;
	let classes: InvocationClass[] = [];
	for (const command of ENGINE_COMMANDS) {
		// Every alias names the flag (`-p` is `--print`).
		const required = command.flags.filter((flag) => flag.required).map((flag) => flag.names);
		const flagsGiven = required.every((aliases) => aliases.some((name) => options.includes(name)));
		const kind = INVOCATION_CLASSES[command.call]?.kind ?? "reads_table";
		if (!names(command.argv, required, flagsGiven, kind, options)) continue;
		// A form whose required flag is given is the more specific one (`update --models`); a subcommand form whose
		// required flag is missing still names the command, below any form that needs no flag.
		const specificity = command.argv.length * 10 + (flagsGiven ? required.length : -0.5);
		if (specificity > best) {
			best = specificity;
			classes = [kind];
		} else if (specificity === best) classes.push(kind);
	}
	return classes.length > 0 && classes.every((kind) => kind === "no_session") ? "no_session" : "reads_table";
}
