/**
 * Threat model: a mistaken agent, not an adversary. The guard judges a `bash_input` line by the text it can see, and
 * bash can run a line the guard did not see: a history recall through a key it does not model (vi mode, a key rebound
 * with `bind`), `fc`, history characters changed with `histchars`, an alias. Rather than enumerate those paths, the
 * guard refuses instead of guessing in two cases: a line edited with a key it cannot follow (`typed-lines.ts`), and a
 * line that reconfigures the shell's line editing, history or command lookup, or whose command word it cannot read
 * (this file). Both trigger only on unusual editing or on shell reconfiguration through `bash_input`; plain typing and
 * the `bash` tool are unaffected.
 */
import {
	analyzeBashCommandWords,
	type BashCommandSegment,
	bestEffortCommandLines,
} from "../permission-system/bash-command-segments.ts";

/** Why a `bash_input` line is refused unjudged: it reconfigures the shell, or the guard cannot read its command. */
export type ShellReconfiguration = "reconfigure" | "dynamic-command" | "unparsed";

const RECONFIGURING = new Set(["bind", "set", "shopt", "history", "alias", "fc"]);
const KILL_FAMILY = new Set(["kill", "pkill", "killall"]);
// Any assignment to histchars or HISTFILE: `histchars=@`, `HISTFILE+=x`, `export HISTFILE=x`, `${histchars:=@}`.
const HISTORY_VARIABLE = /\b(?:histchars|HISTFILE)(?:\+|:)?=/;

/** `set -H` (or a cluster holding H), or `set -o`/`+o` naming vi, emacs or histexpand; `set -o` alone only lists. */
function setsLineEditing(words: readonly string[]): boolean {
	return words.some(
		(word, at) =>
			/^-[A-Za-z]*H/.test(word) || (/^[-+]o$/.test(word) && /^(vi|emacs|histexpand)$/.test(words[at + 1] ?? "")),
	);
}

function reconfigures({ name, words }: BashCommandSegment): boolean {
	const texts = words.map((word) => word.text);
	switch (name) {
		case "bind":
		case "fc":
			return true;
		case "set":
			return setsLineEditing(texts);
		case "shopt":
			return texts.some((word) => /^(hist|vi$|emacs$)/.test(word));
		case "history":
			return texts.some((word) => /^-[A-Za-z]*[rnsa]/.test(word));
		case "alias":
			return texts.some((word) => word.includes("="));
		default:
			return false;
	}
}

/**
 * Whether a `bash_input` line changes key bindings, history or aliases, names its command through an expansion or
 * ANSI-C quoting (`$cmd`, `$'fc'`), or cannot be parsed while its words name one of those commands or a kill-family
 * command. Command words are read after real quote removal, so `"fc"` and `\bind` count.
 */
export function shellReconfiguration(text: string): ShellReconfiguration | undefined {
	if (HISTORY_VARIABLE.test(text)) return "reconfigure";
	const analysis = analyzeBashCommandWords(text);
	if (analysis.kind === "parsed") return analysis.segments.some(reconfigures) ? "reconfigure" : undefined;
	if (analysis.dynamicName) return "dynamic-command";
	const named = bestEffortCommandLines(text).some(
		([word]) => word !== undefined && (RECONFIGURING.has(word) || KILL_FAMILY.has(word)),
	);
	return named ? "unparsed" : undefined;
}
