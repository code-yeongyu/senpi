// The transport guards of a `run` git call (S40 PR 2, design v3.1, senpi#5645). They are part of the argv the hand's
// handlers judge, so the judged command is exactly the one that runs; a caller can never supply or omit them.
import type { TypedPath } from "./hand-run-grammar.ts";

/**
 * The receive-pack every LOCAL push runs (V3). Its `-c` settings reach the local receive-pack and its children: no target
 * or global hook runs, a checked-out branch is refused, and no auto gc or maintenance can prune through the target.
 */
const HARDENED_RECEIVE_PACK = [
	"git",
	"-c core.hooksPath=/dev/null",
	"-c receive.denyCurrentBranch=refuse",
	"-c core.fsmonitor=false",
	"-c receive.autogc=false",
	"-c gc.auto=0",
	"-c maintenance.auto=false",
	"receive-pack",
].join(" ");

/** A REMOTE run may not fall back to a local transport through insteadOf, pushInsteadOf or a remote name (V6). */
const REMOTE_GUARDS = [
	"-c",
	"protocol.file.allow=never",
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"protocol.fd.allow=never",
];

export interface Transport {
	readonly argv: string[];
	readonly env: Record<string, string>;
	/** A local run, whose effective config must then carry no `url.*` rewrite (V5). */
	readonly local: boolean;
}

function subcommandAt(argv: readonly string[]): number {
	let index = 0;
	while (index < argv.length && (argv[index] ?? "").startsWith("-")) index += argv[index] === "-c" ? 2 : 1;
	return index;
}

/** The final argv and environment for a planned git call: local and remote transports each get their own guards. */
export function transportFor(
	argv: readonly string[],
	env: Record<string, string>,
	paths: readonly TypedPath[],
): Transport {
	const at = subcommandAt(argv);
	const sub = argv[at];
	const local = paths.some((path) => path.kind === "source" || path.kind === "target");
	if (local) {
		const pushed = sub === "push" ? [`--receive-pack=${HARDENED_RECEIVE_PACK}`] : [];
		return {
			argv: [...argv.slice(0, at + 1), ...pushed, ...argv.slice(at + 1)],
			env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
			local: true,
		};
	}
	if (sub === "ls-remote" || sub === "push")
		return { argv: [...argv.slice(0, at), ...REMOTE_GUARDS, ...argv.slice(at)], env, local: false };
	return { argv: [...argv], env, local: false };
}
