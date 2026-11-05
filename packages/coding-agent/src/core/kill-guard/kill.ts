import { signalNumberOrName } from "./options.ts";
import { describe, minimalProtected, ownGroup, type Protected, protectedSet } from "./protected.ts";
import { dynamicVerdict, type Situation } from "./situation.ts";
import type { KillGuardContext, KillGuardVerdict, ProcessRow } from "./types.ts";
import { ALLOW, combine, defer, refuse } from "./verdict.ts";

export type KillTarget =
	| { readonly kind: "pid"; readonly pid: number }
	| { readonly kind: "group"; readonly pgid: number }
	| { readonly kind: "all" };

const ALL_PROCESSES = "a target of `-1` signals every process you may signal";

export const refuseAll = (): KillGuardVerdict => refuse("R3", ALL_PROCESSES, "Name the pid.");

function parseTarget(text: string): KillTarget | undefined {
	if (/^\d+$/.test(text)) {
		const pid = Number(text);
		return pid === 0 ? { kind: "group", pgid: 0 } : { kind: "pid", pid };
	}
	if (/^-\d+$/.test(text)) {
		const pgid = Number(text.slice(1));
		return pgid === 1 ? { kind: "all" } : { kind: "group", pgid };
	}
	return undefined;
}

/** Reads the signal word(s) at the start of a `kill` call: the index of the first target, and whether it sends signal 0. */
function readSignal(situation: Situation): { readonly next: number; readonly zero: boolean } | KillGuardVerdict {
	const [first, second] = situation.segment.words;
	if (first === undefined) return { next: 0, zero: false };
	if (first.dynamic) {
		if (!first.literalPrefix.startsWith("-")) return { next: 0, zero: false };
		// `-$SIG`: under a PATH-resetting wrapper its role (signal or group target) is ambiguous (N2).
		if (situation.resetPath) return dynamicVerdict(situation, "a dynamic word starting with `-`");
		return { next: 1, zero: false };
	}
	const text = first.text;
	if (!text.startsWith("-") || text === "--" || text === "-") return { next: 0, zero: false };
	if (text === "-s" || text === "-n" || text === "--signal") {
		const zero = second !== undefined && !second.dynamic && signalNumberOrName(second.text)?.zero === true;
		return { next: 2, zero };
	}
	const name = text.startsWith("--signal=") ? text.slice("--signal=".length) : text.slice(1);
	return { next: 1, zero: signalNumberOrName(name)?.zero === true };
}

/** `kill` (builtin or external): R3 on `-1`, R2 on protected pids, R4 on groups holding a protected process. */
export function judgeKill(situation: Situation, context: KillGuardContext): KillGuardVerdict {
	const words = situation.segment.words;
	const first = words[0];
	if (first === undefined) return ALLOW;
	if (!first.dynamic && /^(-l|-L|--list|--table|-h|--help|-V|--version)$/.test(first.text)) return ALLOW;
	// `kill -1` alone names signal 1 and no pid; it is refused as the all-processes target it looks like.
	if (words.length === 1 && !first.dynamic && first.text === "-1") return refuseAll();
	const signal = readSignal(situation);
	if ("action" in signal) return signal;
	if (signal.zero) return ALLOW;
	const verdicts: KillGuardVerdict[] = [];
	if (first.dynamic && signal.next === 1 && situation.runtimeCovers) {
		verdicts.push(defer("the signal is only known when the command runs"));
	}
	const targets: KillTarget[] = [];
	let optionsDone = false;
	for (const word of words.slice(signal.next)) {
		if (!optionsDone && !word.dynamic && word.text === "--") {
			optionsDone = true;
			continue;
		}
		if (word.dynamic) {
			verdicts.push(dynamicTarget(situation, word.literalPrefix.startsWith("-")));
			continue;
		}
		if (word.text.startsWith("%")) continue;
		const target = parseTarget(word.text);
		if (target !== undefined) targets.push(target);
	}
	if (targets.some((target) => target.kind === "all")) return refuseAll();
	if (context.platform === "win32") return combine(verdicts);
	return combine([judgeTargets(targets, context), ...verdicts]);
}

function dynamicTarget(situation: Situation, group: boolean): KillGuardVerdict {
	if (group) {
		return situation.runtimeCovers
			? defer("a group target is only known when the command runs")
			: dynamicVerdict(situation, "a dynamic group target");
	}
	// A dynamic positive pid: bash's wrapper sees it later; elsewhere it runs unjudged (A1, residual 1).
	if (situation.runtimeCovers || situation.resetPath || situation.builtin) {
		return defer("the pid is only known when the command runs");
	}
	return dynamicVerdict(situation, "a dynamic pid");
}

/** Literal pids and groups, resolved against the caller's vantage. */
export function judgeTargets(targets: readonly KillTarget[], context: KillGuardContext): KillGuardVerdict {
	if (targets.length === 0) return ALLOW;
	const quick = minimalProtected(context);
	for (const target of targets) {
		const reason = target.kind === "pid" ? quick.get(target.pid) : undefined;
		if (target.kind === "pid" && reason !== undefined) {
			return refuse("R2", `it would signal ${describe(target.pid, undefined, reason)}`);
		}
	}
	const groups = targets.flatMap((target) => (target.kind === "group" ? [target.pgid] : []));
	if (groups.includes(0) && context.vantage.kind === "agent") {
		return refuse(
			"R4",
			`a target of 0 signals the agent's own process group, which holds the agent (${context.agentPid})`,
		);
	}
	const view = context.view();
	if (view === undefined) {
		const needsTable = groups.some((pgid) => pgid !== 0 || context.vantage.kind === "process");
		return needsTable
			? refuse("R5", "the process table cannot be read, so the process group cannot be checked")
			: ALLOW;
	}
	const protectedPids = protectedSet(context, view.rows);
	for (const target of targets) {
		const reason = target.kind === "pid" ? protectedPids.get(target.pid) : undefined;
		if (target.kind === "pid" && reason !== undefined) {
			return refuse("R2", `it would signal ${describe(target.pid, view.rows, reason)}`);
		}
	}
	for (const pgid of groups) {
		const resolved = pgid === 0 ? ownGroup(context, view.rows) : pgid;
		if (resolved === undefined) {
			if (pgid === 0 && context.vantage.kind === "fresh-session") continue;
			return refuse("R5", "the caller's process group cannot be read");
		}
		const verdict = judgeGroup(resolved, view.rows, protectedPids);
		if (verdict.action === "refuse") return verdict;
	}
	return ALLOW;
}

export function judgeGroup(pgid: number, rows: readonly ProcessRow[], protectedPids: Protected): KillGuardVerdict {
	const members = rows.filter((row) => row.pgid === pgid && protectedPids.has(row.pid));
	if (members.length === 0) return ALLOW;
	const named = members.map((row) => describe(row.pid, rows, protectedPids.get(row.pid) ?? "protected"));
	return refuse("R4", `process group ${pgid} holds ${named.join(", ")}`);
}
