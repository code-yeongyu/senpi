/**
 * Option tables for the kill-family tools, per platform (DESIGN-12096 v2 §3' R2 with amendment A3). Every option a
 * table does not list makes the invocation UNKNOWN (R5): guessing whether it takes a value could hide a target.
 */

/**
 * `forward`: passed to the dry-run `pgrep`. `drop`: changes nothing about who is selected (output, prompts, the
 * signal). `skip`: output shaping that `pgrep` must not see. `allow`: the call sends nothing (help, list, a dry run).
 * `unknown`: no `pgrep` equivalent, so the targets cannot be resolved.
 */
export type OptionAction = "forward" | "drop" | "skip" | "allow" | "unknown";

export interface OptionSpec {
	readonly takesValue: boolean;
	readonly action: OptionAction;
	/** The short option `pgrep` takes for it (long options are forwarded as their short form). */
	readonly short?: string;
	/** Exact-name match (`-x`, psmisc `-e`). */
	readonly exact?: boolean;
	/** The pattern is a regular expression, not an exact name (killall `-r`, `-m`). */
	readonly regex?: boolean;
	/** Matches whole process groups (psmisc `killall -g`). */
	readonly groups?: boolean;
	/** Includes the caller's ancestors (BSD `-a`). */
	readonly ancestors?: boolean;
	/** Excludes the caller's ancestors (procps `-A`). */
	readonly ignoreAncestors?: boolean;
	/** Sets the signal (`--signal X`, psmisc `-s X`). */
	readonly signal?: boolean;
	/** A selector of its own (a pattern-less `pkill -u x` still selects). */
	readonly selector?: boolean;
	/** Its value may be the caller-relative `0` (`-g 0`, `-s 0`). */
	readonly callerRelative?: "pgid" | "sid";
	readonly ignoreCase?: boolean;
}

export type OptionTable = ReadonlyMap<string, OptionSpec>;

const flag = (action: OptionAction, extra: Partial<OptionSpec> = {}): OptionSpec => ({
	takesValue: false,
	action,
	...extra,
});
const value = (action: OptionAction, extra: Partial<OptionSpec> = {}): OptionSpec => ({
	takesValue: true,
	action,
	...extra,
});

function table(entries: Record<string, OptionSpec>, aliases: Record<string, string> = {}): OptionTable {
	const map = new Map(Object.entries(entries));
	for (const [alias, target] of Object.entries(aliases)) {
		const spec = map.get(target);
		if (spec === undefined) throw new Error(`kill guard option alias ${alias} names no option ${target}`);
		map.set(alias, { ...spec, short: spec.short ?? target });
	}
	return map;
}

/** procps-ng `pkill`/`pgrep` (Linux). */
const PROCPS = table(
	{
		"-f": flag("forward"),
		"-x": flag("forward", { exact: true }),
		"-i": flag("forward", { ignoreCase: true }),
		"-n": flag("forward"),
		"-o": flag("forward"),
		"-v": flag("forward"),
		"-A": flag("forward", { ignoreAncestors: true }),
		"-H": flag("forward"),
		"-L": flag("forward"),
		"-u": value("forward", { selector: true }),
		"-U": value("forward", { selector: true }),
		"-g": value("forward", { selector: true, callerRelative: "pgid" }),
		"-G": value("forward", { selector: true }),
		"-P": value("forward", { selector: true }),
		"-s": value("forward", { selector: true, callerRelative: "sid" }),
		"-t": value("forward", { selector: true }),
		"-r": value("forward", { selector: true }),
		"-F": value("forward", { selector: true }),
		"-O": value("forward", { selector: true }),
		"--ns": value("forward", { selector: true }),
		"--nslist": value("forward"),
		"--cgroup": value("forward", { selector: true }),
		"--env": value("forward", { selector: true }),
		"-e": flag("drop"),
		"-q": value("drop"),
		"--signal": value("drop", { signal: true }),
		"-c": flag("skip"),
		"-l": flag("skip"),
		"-a": flag("skip"),
		"-w": flag("skip"),
		"-d": value("skip"),
		"-h": flag("allow"),
		"-V": flag("allow"),
	},
	{
		"--full": "-f",
		"--exact": "-x",
		"--ignore-case": "-i",
		"--newest": "-n",
		"--oldest": "-o",
		"--inverse": "-v",
		"--ignore-ancestors": "-A",
		"--require-handler": "-H",
		"--logpidfile": "-L",
		"--euid": "-u",
		"--uid": "-U",
		"--pgroup": "-g",
		"--group": "-G",
		"--parent": "-P",
		"--session": "-s",
		"--terminal": "-t",
		"--runstates": "-r",
		"--pidfile": "-F",
		"--older": "-O",
		"--echo": "-e",
		"--queue": "-q",
		"--count": "-c",
		"--list-name": "-l",
		"--list-full": "-a",
		"--lightweight": "-w",
		"--delimiter": "-d",
		"--help": "-h",
		"--version": "-V",
	},
);

/** BSD `pkill`/`pgrep` (macOS). */
const BSD_PGREP = table({
	"-f": flag("forward"),
	"-x": flag("forward", { exact: true }),
	"-i": flag("forward", { ignoreCase: true }),
	"-L": flag("forward"),
	"-n": flag("forward"),
	"-o": flag("forward"),
	"-v": flag("forward"),
	"-q": flag("forward"),
	"-a": flag("forward", { ancestors: true }),
	"-u": value("forward", { selector: true }),
	"-U": value("forward", { selector: true }),
	"-g": value("forward", { selector: true, callerRelative: "pgid" }),
	"-G": value("forward", { selector: true }),
	"-P": value("forward", { selector: true }),
	"-s": value("forward", { selector: true, callerRelative: "sid" }),
	"-t": value("forward", { selector: true }),
	"-F": value("forward", { selector: true }),
	"-I": flag("drop"),
	"-l": flag("skip"),
	"-d": value("skip"),
});

/** psmisc `killall` (Linux). */
const PSMISC_KILLALL = table(
	{
		"-e": flag("forward", { exact: true }),
		"-I": flag("forward", { ignoreCase: true }),
		"-g": flag("forward", { groups: true }),
		"-r": flag("forward", { regex: true }),
		"-u": value("forward", { selector: true }),
		"-i": flag("drop"),
		"-q": flag("drop"),
		"-v": flag("drop"),
		"-w": flag("drop"),
		"-s": value("drop", { signal: true }),
		"-l": flag("allow"),
		"-V": flag("allow"),
		"-y": value("unknown"),
		"-o": value("unknown"),
		"-n": value("unknown"),
		"-Z": value("unknown"),
	},
	{
		"--exact": "-e",
		"--ignore-case": "-I",
		"--process-group": "-g",
		"--regexp": "-r",
		"--user": "-u",
		"--interactive": "-i",
		"--quiet": "-q",
		"--verbose": "-v",
		"--wait": "-w",
		"--signal": "-s",
		"--list": "-l",
		"--version": "-V",
		"--younger-than": "-y",
		"--older-than": "-o",
		"--ns": "-n",
		"--context": "-Z",
	},
);

/** BSD `killall` (macOS). `-s` and `-d` only show what would be signalled. */
const BSD_KILLALL = table({
	"-e": flag("drop"),
	"-m": flag("forward", { regex: true }),
	"-u": value("forward", { selector: true }),
	"-t": value("forward", { selector: true }),
	"-c": value("forward", { selector: true }),
	"-v": flag("drop"),
	"-q": flag("drop"),
	"-z": flag("drop"),
	"-I": flag("drop"),
	"-s": flag("allow"),
	"-d": flag("allow"),
	"-l": flag("allow"),
	"-help": flag("allow"),
});

export type SelectingTool = "pkill" | "pgrep" | "killall";

export function optionTable(tool: SelectingTool, platform: string): OptionTable {
	const linux = platform === "linux";
	if (tool === "killall") return linux ? PSMISC_KILLALL : BSD_KILLALL;
	return linux ? PROCPS : BSD_PGREP;
}

const SIGNAL_NAMES = new Set([
	"HUP",
	"INT",
	"QUIT",
	"ILL",
	"TRAP",
	"ABRT",
	"IOT",
	"BUS",
	"EMT",
	"FPE",
	"KILL",
	"USR1",
	"SEGV",
	"USR2",
	"PIPE",
	"ALRM",
	"TERM",
	"STKFLT",
	"CHLD",
	"CLD",
	"CONT",
	"STOP",
	"TSTP",
	"TTIN",
	"TTOU",
	"URG",
	"XCPU",
	"XFSZ",
	"VTALRM",
	"PROF",
	"WINCH",
	"IO",
	"POLL",
	"PWR",
	"SYS",
	"INFO",
	"LOST",
	"UNUSED",
	"RTMIN",
	"RTMAX",
]);

/** The signal a word names (`9`, `KILL`, `SIGKILL`, `rtmin+3`), or `undefined` when it names none. */
export function signalNumberOrName(text: string): { readonly zero: boolean } | undefined {
	if (/^\d+$/.test(text)) return { zero: Number(text) === 0 };
	const name = text.toUpperCase().replace(/^SIG/, "");
	if (SIGNAL_NAMES.has(name) || /^RTM(IN|AX)[+-]\d+$/.test(name)) return { zero: false };
	if (name === "ZERO" || name === "NULL") return { zero: true };
	return undefined;
}
