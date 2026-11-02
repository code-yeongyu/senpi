/**
 * The POSIX sh text of the kill guard's runtime layer (senpi#5349, DESIGN-12096 §4' L2, amendment A8): `kill`,
 * `pkill` and `killall` shims that judge their real argv before the real binary runs, the `bash_env.sh` that wraps
 * bash's builtin `kill` in non-interactive bash, and the `bash_kill.sh` that the PROMPT_COMMAND hook sources into
 * interactive bash. All share one sh library: the fast path for literal `kill` targets, the bounded judge call, and the
 * judge-missing fallback.
 */
import { refuseAll } from "./kill.ts";
import type { KillGuardVerdict } from "./types.ts";
import { KILL_GUARD_TAG, refuse } from "./verdict.ts";

export const KILL_GUARD_SHIM_NAMES = ["kill", "pkill", "killall"] as const;
export type KillGuardShimName = (typeof KILL_GUARD_SHIM_NAMES)[number];
export const KILL_GUARD_BASH_ENV = "bash_env.sh";
export const KILL_GUARD_BASH_KILL = "bash_kill.sh";
/** Every PROMPT_COMMAND hook starts with this, so an inherited hook is recognised as the kill guard's own. */
export const KILL_GUARD_PROMPT_HOOK_PREFIX = "__senpi_kg_q=$?;";
/** A file every shim directory holds, so a shim looking for the real binary skips every kill-guard directory. */
export const KILL_GUARD_SHIM_MARKER = ".senpi-kill-guard";
/** The table read and the dry run are bounded at 2 s each; the rest covers the judge's own start. */
export const KILL_GUARD_JUDGE_DEADLINE_SECONDS = 10;

export type KillGuardShimFiles = Record<
	KillGuardShimName | typeof KILL_GUARD_BASH_ENV | typeof KILL_GUARD_BASH_KILL,
	string
>;

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const refusal = (verdict: KillGuardVerdict): string => (verdict.action === "refuse" ? verdict.message : "");

const ALL_PROCESSES = refusal(refuseAll());
const PROTECTED_WITHOUT_JUDGE = refusal(
	refuse("R2", "it names a pid the host marked protected, and the kill guard's judge is not installed to check it"),
);
const JUDGE_FAILED = refusal(
	refuse("R5", "the kill guard's judge failed or did not answer in time, so nothing was signalled"),
);
const JUDGE_MISSING = `${KILL_GUARD_TAG} the kill guard's judge is not installed (SENPI_KILL_GUARD_EXEC), so this runs unjudged:`;

function library(deadlineSeconds: number): string {
	return `__senpi_kg_all=${quote(ALL_PROCESSES)}
__senpi_kg_protected=${quote(PROTECTED_WITHOUT_JUDGE)}
__senpi_kg_failed=${quote(JUDGE_FAILED)}
__senpi_kg_missing=${quote(JUDGE_MISSING)}
__senpi_kg_deadline=${deadlineSeconds}

# kill's arguments, decided in sh with no runtime start: 0 = only literal positive pids and none protected,
# 1 = the judge decides, 2 = a literal -1 target, 3 = a literal pid the host marked protected.
__senpi_kg_fast() {
	__senpi_kg_p=0
	__senpi_kg_n=0
	if [ "$#" -eq 1 ] && [ "$1" = "-1" ]; then return 2; fi
	case \${1-} in
	-l | -L) return 0 ;;
	--) ;;
	-*) shift ;;
	esac
	if [ "\${1-}" = "--" ]; then shift; fi
	if [ "$#" -eq 0 ]; then return 1; fi
	for __senpi_kg_a do
		case $__senpi_kg_a in
		-1) return 2 ;;
		'' | 0* | *[!0-9]*) __senpi_kg_n=1 ;;
		*)
			case ,\${SENPI_KILL_GUARD_PROTECTED-}, in
			*,"$__senpi_kg_a",*) __senpi_kg_p=1 ;;
			esac
			;;
		esac
	done
	if [ "$__senpi_kg_p" -eq 1 ]; then return 3; fi
	return "$__senpi_kg_n"
}

__senpi_kg_present() {
	if [ -z "\${SENPI_KILL_GUARD_EXEC-}" ] || [ ! -f "$SENPI_KILL_GUARD_EXEC" ] || [ ! -x "$SENPI_KILL_GUARD_EXEC" ]; then
		return 1
	fi
	[ -z "\${SENPI_KILL_GUARD_EXEC_ENTRY-}" ] || [ -f "$SENPI_KILL_GUARD_EXEC_ENTRY" ]
}

# The judge on the real argv, killed by a watchdog after the deadline: 0 allows, 126 refuses, anything else failed.
__senpi_kg_judge() (
	unset BUN_BE_BUN
	ELECTRON_RUN_AS_NODE=1
	export ELECTRON_RUN_AS_NODE
	__senpi_kg_v=$1
	shift
	if [ -n "\${SENPI_KILL_GUARD_EXEC_ENTRY-}" ]; then
		"$SENPI_KILL_GUARD_EXEC" "$SENPI_KILL_GUARD_EXEC_ENTRY" __kill-guard check --vantage "$__senpi_kg_v" -- "$@" </dev/null &
	else
		"$SENPI_KILL_GUARD_EXEC" __kill-guard check --vantage "$__senpi_kg_v" -- "$@" </dev/null &
	fi
	__senpi_kg_j=$!
	(
		trap 'command kill "\${__senpi_kg_t-}" 2>/dev/null; exit 0' TERM
		command sleep "$__senpi_kg_deadline" &
		__senpi_kg_t=$!
		if wait "$__senpi_kg_t"; then command kill -KILL "$__senpi_kg_j" 2>/dev/null; fi
	) </dev/null >/dev/null 2>&1 &
	__senpi_kg_w=$!
	__senpi_kg_s=0
	wait "$__senpi_kg_j" || __senpi_kg_s=$?
	command kill "$__senpi_kg_w" 2>/dev/null || :
	exit "$__senpi_kg_s"
)

# One invocation: $1 is the pid that will send the signal, the rest its argv. Returns 0 to run it, else its status.
__senpi_kg_decide() {
	__senpi_kg_v=$1
	shift
	__senpi_kg_f=1
	if [ "$1" = kill ]; then
		shift
		__senpi_kg_f=0
		__senpi_kg_fast "$@" || __senpi_kg_f=$?
		set -- kill "$@"
		case $__senpi_kg_f in
		0) return 0 ;;
		2)
			printf '%s\\n' "$__senpi_kg_all" >&2
			return 126
			;;
		esac
	fi
	if ! __senpi_kg_present; then
		if [ "$__senpi_kg_f" -eq 3 ]; then
			printf '%s\\n' "$__senpi_kg_protected" >&2
			return 126
		fi
		printf '%s %s\\n' "$__senpi_kg_missing" "$1" >&2
		return 0
	fi
	__senpi_kg_s=0
	__senpi_kg_judge "$__senpi_kg_v" "$@" || __senpi_kg_s=$?
	case $__senpi_kg_s in
	0) return 0 ;;
	126) return 126 ;;
	esac
	printf '%s (judge status %s)\\n' "$__senpi_kg_failed" "$__senpi_kg_s" >&2
	return 126
}
`;
}

function shim(dir: string, name: KillGuardShimName, deadlineSeconds: number): string {
	return `#!/bin/sh
# senpi kill guard (senpi#5349): runs \`${name}\` only after the judge allows its real argv. Written by senpi.
__senpi_kg_dir=${quote(dir)}
__senpi_kg_name=${name}
${library(deadlineSeconds)}
# The real binary: the first PATH match outside every kill-guard shim directory that no outer shim already ran. A
# symlink to a shim elsewhere on PATH re-enters a shim, so each shim lists what it execs in SENPI_KILL_GUARD_VISITED and
# skips every listed path: each re-entry removes one candidate, so the walk ends.
__senpi_kg_find() (
	set -f
	IFS=:
	for __senpi_kg_d in \${PATH-}; do
		if [ -z "$__senpi_kg_d" ]; then __senpi_kg_d=.; fi
		if [ "$__senpi_kg_d" = "$__senpi_kg_dir" ] || [ -f "$__senpi_kg_d/${KILL_GUARD_SHIM_MARKER}" ]; then continue; fi
		case :\${SENPI_KILL_GUARD_VISITED-}: in
		*:"$__senpi_kg_d/$1":*) continue ;;
		esac
		if [ -f "$__senpi_kg_d/$1" ] && [ -x "$__senpi_kg_d/$1" ]; then
			printf '%s\\n' "$__senpi_kg_d/$1"
			exit 0
		fi
	done
	exit 1
)

__senpi_kg_s=0
__senpi_kg_decide "$$" "$__senpi_kg_name" "$@" || __senpi_kg_s=$?
if [ "$__senpi_kg_s" -ne 0 ]; then exit "$__senpi_kg_s"; fi
if __senpi_kg_real=$(__senpi_kg_find "$__senpi_kg_name"); then
	SENPI_KILL_GUARD_VISITED=\${SENPI_KILL_GUARD_VISITED:+$SENPI_KILL_GUARD_VISITED:}$__senpi_kg_real
	export SENPI_KILL_GUARD_VISITED
	exec "$__senpi_kg_real" "$@"
fi
printf '%s: command not found\\n' "$__senpi_kg_name" >&2
exit 127
`;
}

function bashEnv(deadlineSeconds: number): string {
	return `# senpi kill guard (senpi#5349): BASH_ENV for agent shells. Sources the user's own BASH_ENV first, then judges
# bash's builtin \`kill\` on its real argv. Written by senpi.
if [ -n "\${SENPI_KILL_GUARD_USER_BASH_ENV-}" ] && [ "$SENPI_KILL_GUARD_USER_BASH_ENV" != "\${BASH_SOURCE[0]-}" ] &&
	[ -f "$SENPI_KILL_GUARD_USER_BASH_ENV" ]; then
	. "$SENPI_KILL_GUARD_USER_BASH_ENV"
fi
${killFunction(deadlineSeconds)}`;
}

// `function kill` rather than `kill()`: a user alias named kill would otherwise expand inside the definition. `command
// kill` runs the builtin, or the PATH shim once `enable -n kill` disabled the builtin (`builtin kill` would then fail).
function killFunction(deadlineSeconds: number): string {
	return `${library(deadlineSeconds)}
function kill {
	local __senpi_kg_v __senpi_kg_f __senpi_kg_s __senpi_kg_p __senpi_kg_n __senpi_kg_a
	__senpi_kg_decide "\${BASHPID:-$$}" kill "$@" || return
	command kill "$@"
}
`;
}

function bashKill(deadlineSeconds: number): string {
	return `# senpi kill guard (senpi#5349): sourced into interactive bash by the PROMPT_COMMAND hook before the first prompt,
# after the user's startup files; judges bash's builtin \`kill\` on its real argv. Written by senpi.
${killFunction(deadlineSeconds)}`;
}

/**
 * The PROMPT_COMMAND that carries the `kill` wrapper into interactive bash, which reads no BASH_ENV. Before a prompt it
 * sources `bash_kill.sh` once per shell (the marker is an unexported variable keyed on `$$`, so a child bash sources it
 * again), then runs the user's own PROMPT_COMMAND with `$?` as the last command left it. A kill-guard hook inside the
 * user's value is not re-entered: the re-entry marker is a `local` of the function that evals the user's value, so it
 * exists only while that eval runs, and bash drops it when Ctrl-C or an expansion error abandons the eval midway.
 */
export function killGuardPromptCommand(dir: string): string {
	const file = quote(`${dir}/${KILL_GUARD_BASH_KILL}`);
	const user = '"$SENPI_KILL_GUARD_USER_PROMPT_COMMAND"';
	return [
		KILL_GUARD_PROMPT_HOOK_PREFIX,
		`if [ "\${__senpi_kg_shell-}" != "$$" ]; then __senpi_kg_shell=$$; if [ -r ${file} ]; then . ${file}; fi; fi;`,
		`if [ -n "\${SENPI_KILL_GUARD_USER_PROMPT_COMMAND-}" ] && [ "\${__senpi_kg_in-}" != "$$" ]; then`,
		'__senpi_kg_rc() { return "$1"; }; __senpi_kg_run() { local __senpi_kg_in=$$;',
		`if __senpi_kg_rc "$__senpi_kg_q"; then eval ${user}; else eval ${user}; fi; }; __senpi_kg_run; fi`,
	].join(" ");
}

/** Every file of one shim directory; `dir` is baked into the shims so a shim never resolves to itself. */
export function renderKillGuardShims(
	dir: string,
	deadlineSeconds: number = KILL_GUARD_JUDGE_DEADLINE_SECONDS,
): KillGuardShimFiles {
	return {
		kill: shim(dir, "kill", deadlineSeconds),
		pkill: shim(dir, "pkill", deadlineSeconds),
		killall: shim(dir, "killall", deadlineSeconds),
		[KILL_GUARD_BASH_ENV]: bashEnv(deadlineSeconds),
		[KILL_GUARD_BASH_KILL]: bashKill(deadlineSeconds),
	};
}
