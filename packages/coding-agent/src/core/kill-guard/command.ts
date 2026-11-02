import {
	analyzeBashCommandWords,
	type BashCommandSegment,
	bestEffortCommandLines,
} from "../extensions/builtin/permission-system/bash-command-segments.ts";
import { judgeKill, judgeTargets, type KillTarget, refuseAll } from "./kill.ts";
import { judgeSelecting } from "./selecting.ts";
import { situationOf } from "./situation.ts";
import type { KillGuardContext, KillGuardVerdict, SignalCall } from "./types.ts";
import { ALLOW, combine, defer, refuse } from "./verdict.ts";

const KILL_FAMILY = new Set(["kill", "pkill", "killall"]);
const basename = (text: string) => text.split("/").pop() ?? text;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function pipedIntoKill(segment: BashCommandSegment, segments: readonly BashCommandSegment[]): boolean {
	const position = segments.indexOf(segment);
	return segments.some(
		(other, index) => index > position && other.pipeline === segment.pipeline && KILL_FAMILY.has(other.name),
	);
}

/** The command line nix-shell runs (`--run`/`--command`), or the applet line busybox runs (`busybox sh -c ...`). */
function innerScript(segment: BashCommandSegment): string | undefined {
	if (segment.name === "busybox")
		return segment.words.some((word) => word.dynamic)
			? undefined
			: segment.words.map((word) => quote(word.text)).join(" ");
	const index = segment.words.findIndex((word) => word.text === "--run" || word.text === "--command");
	const script = index < 0 ? undefined : segment.words[index + 1];
	return script === undefined || script.dynamic ? undefined : script.text;
}

/** nix-shell, busybox, chroot and systemd-run run a command the lexer does not unwrap; the guard reads it from their words. */
function unwrapOpaque(segment: BashCommandSegment): BashCommandSegment[] {
	const wrapper = { name: segment.name, words: segment.words };
	if (segment.name === "nix-shell" || segment.name === "busybox") {
		const script = innerScript(segment);
		if (script === undefined) return [];
		const inner = analyzeBashCommandWords(script);
		if (inner.kind !== "parsed") return [];
		return inner.segments.map((child) => ({ ...child, wrappers: [...segment.wrappers, wrapper, ...child.wrappers] }));
	}
	if (segment.name !== "chroot" && segment.name !== "systemd-run") return [];
	const index = segment.words.findIndex((word) => !word.dynamic && KILL_FAMILY.has(basename(word.text)));
	const command = index < 0 ? undefined : segment.words[index];
	if (command === undefined) return [];
	return [
		{
			name: basename(command.text),
			nameSpelling: command.text,
			nameIsPath: command.text.includes("/"),
			words: segment.words.slice(index + 1),
			wrappers: [...segment.wrappers, wrapper],
			pipeline: segment.pipeline,
		},
	];
}

function judgeSegment(
	segment: BashCommandSegment,
	segments: readonly BashCommandSegment[],
	context: KillGuardContext,
): KillGuardVerdict {
	const situation = situationOf(segment, context);
	switch (segment.name) {
		case "kill":
			return judgeKill(situation, context);
		case "pkill":
		case "killall":
			return judgeSelecting(situation, segment.name, context, false);
		case "pgrep":
			return judgeSelecting(situation, "pgrep", context, pipedIntoKill(segment, segments));
		default:
			return combine(unwrapOpaque(segment).map((inner) => judgeSegment(inner, segments, context)));
	}
}

/** A command the lexer cannot parse is refused only for a literal `kill -1`; other kill words are left to runtime. */
function judgeUnparsed(command: string): KillGuardVerdict {
	// `env -S` / `--split-string` take a whole command line inside one word (`--split-string=kill -9 -1`, `-Skill -1`):
	// the words after `=` and after a glued `-S` are read as command starts too.
	const lines = [command, command.replaceAll("=", " "), command.replace(/(^|[\s'"])-S/g, "$1")].flatMap((text) =>
		bestEffortCommandLines(text),
	);
	for (const [name, second, third] of lines) {
		if (name !== "kill") continue;
		const signalThenAll = (second === "--" || /^-[A-Za-z0-9]+$/.test(second ?? "")) && third === "-1";
		if (second === "-1" || signalThenAll) return refuseAll();
	}
	if (lines.some(([name]) => KILL_FAMILY.has(name ?? ""))) return defer("the command cannot be parsed before it runs");
	return ALLOW;
}

/** Judges every kill-family invocation a command line would run (L1, DESIGN-12096 §4'). */
export function judgeCommand(command: string, context: KillGuardContext): KillGuardVerdict {
	if (!command.includes("kill")) return ALLOW;
	const analysis = analyzeBashCommandWords(command);
	if (analysis.kind === "unparsed") return judgeUnparsed(command);
	return combine(analysis.segments.map((segment) => judgeSegment(segment, analysis.segments, context)));
}

/** Judges a spawn argv (no shell reads it); `["sh", "-c", script]` is read through the script. */
export function judgeArgv(argv: readonly string[], context: KillGuardContext): KillGuardVerdict {
	if (!argv.some((word) => word.includes("kill"))) return ALLOW;
	return judgeCommand(argv.map(quote).join(" "), { ...context, shell: "argv" });
}

function signalTarget(call: SignalCall): KillTarget | undefined {
	if (call.group) return call.target < 0 ? undefined : { kind: "group", pgid: call.target };
	if (call.target === -1) return { kind: "all" };
	if (call.target <= 0) return { kind: "group", pgid: -call.target };
	return { kind: "pid", pid: call.target };
}

/** Judges `process.kill` / `os.kill` / `os.killpg` on a numeric target (E6, E8). */
export function judgeSignal(call: SignalCall, context: KillGuardContext): KillGuardVerdict {
	if (call.signal === 0 || call.signal === "0" || call.signal === "SIG0") return ALLOW;
	if (!Number.isInteger(call.target)) return ALLOW;
	const target = signalTarget(call);
	if (target === undefined) return refuse("R5", `a negative process group ${call.target} cannot be signalled`);
	if (target.kind === "all") return refuseAll();
	if (context.platform === "win32") return ALLOW;
	return judgeTargets([target], context);
}
