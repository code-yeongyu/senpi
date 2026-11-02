import type { KillGuardRule, KillGuardVerdict } from "./types.ts";

export const KILL_GUARD_TAG = "[senpi:kill-guard]";

const RULE_NAMES: Record<KillGuardRule, string> = {
	R1: "BROAD_PATTERN",
	R2: "PROTECTED_TARGET",
	R3: "ALL_PROCESSES",
	R4: "GROUP",
	R5: "UNKNOWN",
};

const OFF_SWITCH = 'To allow broad kills, set "terminal.killGuard": "off" in your user settings.';
export const NARROW =
	"Signal only what you mean: list it with `pgrep -a -f '^<full command prefix>'` and run `kill <pid>`, use `pkill -x <exact name>`, or stop a senpi job or monitor with kill_bash.";

export const ALLOW: KillGuardVerdict = { action: "allow" };

/** One stderr line: the tag, the rule, the evidence, the narrow alternative and the setting that turns the guard off. */
export function refuse(
	rule: KillGuardRule,
	evidence: string,
	alternative = NARROW,
): Extract<KillGuardVerdict, { readonly action: "refuse" }> {
	const line = `${KILL_GUARD_TAG} refused (${rule} ${RULE_NAMES[rule]}): ${evidence}. ${alternative} ${OFF_SWITCH}`;
	return { action: "refuse", rule, message: line.replace(/\s*\n\s*/g, " ") };
}

export const defer = (reason: string): KillGuardVerdict => ({ action: "defer", reason });

/** The first refusal wins; otherwise a defer; otherwise allow. */
export function combine(verdicts: Iterable<KillGuardVerdict>): KillGuardVerdict {
	let deferred: KillGuardVerdict | undefined;
	for (const verdict of verdicts) {
		if (verdict.action === "refuse") return verdict;
		if (verdict.action === "defer") deferred ??= verdict;
	}
	return deferred ?? ALLOW;
}
