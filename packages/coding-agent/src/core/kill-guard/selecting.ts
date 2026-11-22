import { judgeGroup } from "./kill.ts";
import type { SelectingTool } from "./options.ts";
import { judgePattern, type PatternMode } from "./pattern.ts";
import { describe, protectedSet, rowOf, vantageChain } from "./protected.ts";
import { readSelection, type Selection } from "./selection.ts";
import type { Situation } from "./situation.ts";
import type { KillGuardContext, KillGuardVerdict } from "./types.ts";
import { ALLOW, NARROW, refuse } from "./verdict.ts";

const escapeRegex = (text: string) => text.replace(/[.^$|()[\]{}*+?\\]/g, "\\$&");

function broadPatternHint(tool: SelectingTool, mode: PatternMode, pattern: string, literalName: boolean): string {
	if (mode === "substring" && pattern.length === 1 && tool === "pkill") {
		return `Match the exact name instead: \`pkill -x ${pattern}\`.`;
	}
	if (literalName) return NARROW;
	return "Anchor the pattern to the full command (`pkill -f '^<full command prefix>'`) or match the exact name with `-x`.";
}

/** `pkill`, `killall`, and `pgrep` when its output feeds `kill` in the same pipeline (R1, R2, R3, R4, R5). */
export function judgeSelecting(
	situation: Situation,
	tool: SelectingTool,
	context: KillGuardContext,
	pipedIntoKill: boolean,
): KillGuardVerdict {
	if (tool === "pgrep" && !pipedIntoKill) return ALLOW;
	const selection = readSelection(situation, tool, context.platform);
	if (selection.sendsNothing || selection.signalZero || context.platform === "win32") return ALLOW;
	const mode: PatternMode = selection.exact ? "exact" : "substring";
	for (const pattern of selection.patterns) {
		const verdict = judgePattern(pattern, mode);
		if (verdict.broad) {
			const hint = broadPatternHint(tool, mode, pattern, tool === "killall" && !selection.regex);
			return refuse("R1", `the pattern ${JSON.stringify(pattern)} ${verdict.why}`, hint);
		}
	}
	if (tool === "pgrep") return ALLOW;
	const spelling = situation.segment.nameSpelling;
	if (selection.unknownOption !== undefined) {
		return refuse(
			"R5",
			`\`${spelling}\` option ${selection.unknownOption} is not one the guard can resolve`,
			"Leave the option out or name the pid.",
		);
	}
	if (selection.dynamic !== undefined) return selection.dynamic;
	if (selection.patterns.length === 0 && selection.selectors === 0) {
		return refuse(
			"R3",
			`\`${spelling}\` with no name and no selector signals every process it can`,
			"Name the process.",
		);
	}
	return judgeSelectionTargets(selection, context);
}

/** One `pgrep` per killall name: an exact name is matched literally, `-r`/`-m` names as patterns. */
function dryRuns(selection: Selection, args: readonly string[]): string[][] {
	if (selection.tool !== "killall") return [[...args, ...selection.patterns]];
	const base = selection.ignoreCase ? [...args, "-i"] : [...args];
	if (selection.patterns.length === 0) return [base];
	return selection.patterns.map((name) => (selection.regex ? [...base, name] : [...base, "-x", escapeRegex(name)]));
}

function callerArgs(
	selection: Selection,
	context: KillGuardContext,
	rows: Parameters<typeof rowOf>[0],
): string[] | KillGuardVerdict {
	const args = [...selection.args];
	for (const relative of selection.callerRelative) {
		const pid =
			context.vantage.kind === "agent"
				? context.agentPid
				: context.vantage.kind === "process"
					? context.vantage.pid
					: 0;
		const row = rowOf(rows, pid);
		const id = row === undefined ? 0 : relative.kind === "pgid" ? row.pgid : row.sid;
		if (id <= 0)
			return refuse("R5", `the caller's ${relative.kind === "pgid" ? "process group" : "session"} cannot be read`);
		args.push(relative.option, String(id));
	}
	return args;
}

function judgeSelectionTargets(selection: Selection, context: KillGuardContext): KillGuardVerdict {
	// `-g 0` / `-s 0` from a fresh shell name only the command's own new group or session.
	if (selection.callerRelative.length > 0 && context.vantage.kind === "fresh-session") return ALLOW;
	const view = context.view();
	if (view === undefined)
		return refuse("R5", "the process table cannot be read, so what it selects cannot be checked");
	const args = callerArgs(selection, context, view.rows);
	if (!Array.isArray(args)) return args;
	const bsd = context.platform !== "linux";
	// The host's own dry run must not drop the host's ancestors, which are the agent's.
	if (bsd && !selection.ancestors) args.unshift("-a");
	const selected = new Set<number>();
	for (const run of dryRuns(selection, args)) {
		const result = view.select(run);
		if (!result.ok) return refuse("R5", `its selection cannot be resolved (${result.reason})`);
		for (const pid of result.pids) selected.add(pid);
	}
	// BSD `pkill` (not `killall`) leaves out its own ancestors unless `-a`; procps does so only with `-A`.
	if (selection.ignoreAncestors || (bsd && selection.tool === "pkill" && !selection.ancestors)) {
		for (const pid of vantageChain(context, view.rows)) selected.delete(pid);
	}
	const protectedPids = protectedSet(context, view.rows);
	if (selection.groups) {
		for (const pgid of new Set([...selected].map((pid) => rowOf(view.rows, pid)?.pgid ?? pid))) {
			const verdict = judgeGroup(pgid, view.rows, protectedPids);
			if (verdict.action === "refuse") return verdict;
		}
		return ALLOW;
	}
	const hits = [...selected].filter((pid) => protectedPids.has(pid)).sort((a, b) => a - b);
	if (hits.length === 0) return ALLOW;
	const named = hits.map((pid) => describe(pid, view.rows, protectedPids.get(pid) ?? "protected"));
	return refuse("R2", `it would signal ${named.join(", ")}`);
}
