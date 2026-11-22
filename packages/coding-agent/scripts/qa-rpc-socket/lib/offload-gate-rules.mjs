/**
 * Improvement thresholds of the offload gate (plan, Verification strategy). Every row is evaluated
 * on the CANDIDATE report only; the baseline is read solely as the reference for the serialization
 * row and is never threshold-checked itself. A missing candidate measurement fails its row.
 */

/** Functions that must be absent from the server's top-50 by inclusive samples at gate 35. */
export const ABSENT_FUNCTIONS = Object.freeze([
	"enumerateCandidates",
	"searchSegments",
	"readdir",
	"realpath",
	"slashPath",
	"spawn",
	"loadEntriesFromFile",
	"prepareCompaction",
]);

const TOP_N = 50;
const SERIALIZATION_FUNCTIONS = ["JSON.stringify", "transformJsonValue"];
const SERIALIZATION_SLACK_PT = 2;

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const topOf = (report) => (Array.isArray(report?.cpu?.server?.top) ? report.cpu.server.top : undefined);
const shareIn = (top, name) => top.find((row) => row.function === name)?.share ?? 0;
const serializationShare = (top) => SERIALIZATION_FUNCTIONS.reduce((sum, name) => sum + shareIn(top, name), 0);

function limitRow(row, value, limit, compare) {
	if (value === undefined) return { row, pass: false, reason: "measurement_missing", limit };
	const pass = compare === "lt" ? value < limit : value <= limit;
	return { row, pass, value, limit, ...(pass ? {} : { reason: "threshold_exceeded" }) };
}

const ROWS = {
	probe_p99: ({ candidate }) => limitRow("probe_p99", number(candidate.probe?.p99), 20, "le"),
	big_open_probe_max: ({ candidate }) =>
		limitRow("big_open_probe_max", number(candidate.big_open_probe_max_ms), 100, "lt"),
	turn_mb_per_session: ({ candidate }) => {
		const opened = number(candidate.memory?.opened?.server_mb);
		const afterTurns = number(candidate.memory?.after_turns?.server_mb);
		const sessions = number(candidate.sessions);
		const value =
			opened === undefined || afterTurns === undefined || !sessions ? undefined : (afterTurns - opened) / sessions;
		return limitRow("turn_mb_per_session", value, 30, "le");
	},
	after_close_mb: ({ candidate }) => limitRow("after_close_mb", number(candidate.memory?.after_close?.server_mb), 150, "le"),
	child_idle_mb: ({ candidate }) => limitRow("child_idle_mb", number(candidate.child_idle_mb), 60, "le"),
	function_absence: ({ candidate, functions }) => {
		const top = topOf(candidate);
		if (top === undefined) return { row: "function_absence", pass: false, reason: "measurement_missing" };
		const named = functions ?? ABSENT_FUNCTIONS;
		const present = top.slice(0, TOP_N).filter((row) => named.includes(row.function)).map((row) => row.function);
		const scope = functions === undefined ? "full set" : `scoped to ${named.join(",")}`;
		return present.length === 0
			? { row: "function_absence", pass: true, detail: scope }
			: { row: "function_absence", pass: false, reason: "function_present", detail: `${present.join(",")} (${scope})` };
	},
	build_compaction_context: ({ candidate }) => {
		const top = topOf(candidate);
		return limitRow("build_compaction_context", top && shareIn(top, "buildCompactionContext"), 1, "lt");
	},
	serialization: ({ baseline, candidate }) => {
		const top = topOf(candidate);
		const reference = topOf(baseline);
		if (top === undefined || reference === undefined) {
			return { row: "serialization", pass: false, reason: "measurement_missing" };
		}
		return limitRow("serialization", serializationShare(top), serializationShare(reference) + SERIALIZATION_SLACK_PT, "le");
	},
};

export const GATE_ROWS = Object.freeze(Object.keys(ROWS));

/**
 * `{ pass, rows }`; `only` restricts to one row, `functions` scopes the function-absence row.
 * @param {{ baseline: any, candidate: any, only?: string, functions?: readonly string[] }} input
 */
export function evaluateGate({ baseline, candidate, only, functions }) {
	if (only !== undefined && !(only in ROWS)) throw new Error(`unknown gate row: ${only} (rows: ${GATE_ROWS.join(", ")})`);
	const names = only === undefined ? GATE_ROWS : [only];
	const rows = names.map((name) => ({ subject: "candidate", ...ROWS[name]({ baseline, candidate, functions }) }));
	return { pass: rows.every((row) => row.pass), rows };
}
