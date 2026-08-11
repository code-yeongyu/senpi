/**
 * Detects commands whose whole purpose is to *wait* — `sleep 270; git log`,
 * `for ...; do ...; sleep 5; done`, a bare `sleep 30`. Such a command should not
 * hold the foreground: it detaches early so the session can keep working while
 * the wait finishes in the background and its completion notification lands.
 *
 * Settle sleeps (`pkill; sleep 1`, a 2s server warm-up) are deliberately NOT
 * sleep-waits: they are short by construction and detaching them would cost a
 * notification round-trip for nothing.
 */

/** Minimum `sleep` seconds for a non-loop command to count as a wait. */
export const SLEEP_WAIT_THRESHOLD_SECONDS = 10;
/** Minimum per-iteration `sleep` seconds for a polling loop to count as a wait. */
export const SLEEP_WAIT_LOOP_THRESHOLD_SECONDS = 2;

export type SleepWaitRule = "R1" | "R2" | "R3" | "R4";

export interface SleepWaitClassification {
	readonly kind: "sleep-wait";
	/** R1 pure, R2 leading chain, R3 polling loop, R4 trailing. */
	readonly rule: SleepWaitRule;
	/** Longest `sleep` argument that made the command match. */
	readonly seconds: number;
}

/** `env A=1 bash -lc '...'` wrappers hide the real command from every rule below. */
const SHELL_WRAPPER = /^(?:env\s+(?:[\w.]+=[^\s]*\s+)*)?(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c\s+/i;
/** Power management takes a `sleep` argument that has nothing to do with waiting. */
const POWER_MANAGEMENT = /\b(?:pmset|systemsetup|caffeinate|displaysleep|disksleep)\b/;
/** `sleep N` as a real command word — never `./sleepless 300` or `--sleep=3`. */
const SLEEP_CALL = /(?<![\w.\-/])(?:\/(?:usr\/)?bin\/)?sleep\s+(\d+(?:\.\d+)?)/g;

const PURE = /^sleep\s+\d+(?:\.\d+)?$/;
const LEADING = /^\(?\s*(?:\/(?:usr\/)?bin\/)?sleep\s+\d+(?:\.\d+)?\s*(?:[;&|]|$)/;
const LOOP = /\b(?:while|until|for)\b[\s\S]*?(?<![\w.\-/])(?:\/(?:usr\/)?bin\/)?sleep\s+\d/;
const TRAILING = /[;&|]\s*(?:\/(?:usr\/)?bin\/)?sleep\s+\d+(?:\.\d+)?\s*\)?\s*$/;

function unwrap(command: string): string {
	let current = command.trim();
	for (let depth = 0; depth < 3; depth += 1) {
		const stripped = current.replace(SHELL_WRAPPER, "");
		if (stripped === current) break;
		current = stripped.trim();
		const quote = current[0];
		if ((quote === "'" || quote === '"') && current.endsWith(quote) && current.length > 1) {
			current = current.slice(1, -1).trim();
		}
	}
	return current;
}

function longestSleepSeconds(command: string): number | undefined {
	SLEEP_CALL.lastIndex = 0;
	let longest: number | undefined;
	for (const match of command.matchAll(SLEEP_CALL)) {
		const seconds = Number.parseFloat(match[1] ?? "");
		if (!Number.isFinite(seconds)) continue;
		if (longest === undefined || seconds > longest) longest = seconds;
	}
	return longest;
}

/**
 * Classify a bash command as a sleep-wait, or `undefined` when it is ordinary
 * work (including short settle sleeps below the thresholds).
 */
export function classifySleepWait(command: string): SleepWaitClassification | undefined {
	if (POWER_MANAGEMENT.test(command)) return undefined;
	const unwrapped = unwrap(command);
	const seconds = longestSleepSeconds(unwrapped);
	if (seconds === undefined) return undefined;

	if (LOOP.test(unwrapped)) {
		return seconds >= SLEEP_WAIT_LOOP_THRESHOLD_SECONDS ? { kind: "sleep-wait", rule: "R3", seconds } : undefined;
	}
	if (seconds < SLEEP_WAIT_THRESHOLD_SECONDS) return undefined;
	if (PURE.test(unwrapped)) return { kind: "sleep-wait", rule: "R1", seconds };
	if (LEADING.test(unwrapped)) return { kind: "sleep-wait", rule: "R2", seconds };
	if (TRAILING.test(unwrapped)) return { kind: "sleep-wait", rule: "R4", seconds };
	return undefined;
}
