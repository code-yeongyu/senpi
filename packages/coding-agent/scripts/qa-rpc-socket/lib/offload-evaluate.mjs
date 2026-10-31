/**
 * The derived validity oracle of `offload-profile.mjs`. A run is valid only when every expected
 * record and measurement is present; anything missing is a named failure, never a pass.
 */

/** Per-session `tool_execution_end` histogram of the workload (`offload-workload.mjs`). */
export const EXPECTED_HISTOGRAM = Object.freeze({ eval: 6, read: 2, todo: 2, write: 2, edit: 2 });

const EVENTS_PER_SESSION = Object.values(EXPECTED_HISTOGRAM).reduce((sum, count) => sum + count, 0);

export const REQUIRED_PHASES = Object.freeze(["empty", "opened", "after_turns", "after_big_opens", "after_close"]);

export function expectedToolEvents(sessions) {
	return sessions * EVENTS_PER_SESSION;
}

function histogramOf(events) {
	const histogram = {};
	for (const event of events) histogram[event.tool] = (histogram[event.tool] ?? 0) + 1;
	return histogram;
}

function sameHistogram(actual) {
	const keys = new Set([...Object.keys(actual), ...Object.keys(EXPECTED_HISTOGRAM)]);
	for (const key of keys) if ((actual[key] ?? 0) !== (EXPECTED_HISTOGRAM[key] ?? 0)) return false;
	return true;
}

function checkSessions(report, fail) {
	const sessions = Number.isInteger(report.sessions) && report.sessions > 0 ? report.sessions : undefined;
	const details = Array.isArray(report.sessions_detail) ? report.sessions_detail : [];
	if (sessions === undefined || details.length !== sessions) {
		fail("measurement_missing", `sessions=${report.sessions} details=${details.length}`);
		return;
	}
	const unsettled = details.filter((session) => session.settled !== true).map((session) => session.n);
	if (unsettled.length > 0) fail("turn_timeout", `unsettled sessions: ${unsettled.join(",")}`);
	const events = details.flatMap((session) => (Array.isArray(session.tool_events) ? session.tool_events : []));
	const expected = expectedToolEvents(sessions);
	if (events.length !== expected || report.tool_events_total !== expected) {
		fail("tool_count_mismatch", `tool_execution_end=${events.length} total=${report.tool_events_total} expected=${expected}`);
	} else {
		const off = details.filter((session) => !sameHistogram(histogramOf(session.tool_events)));
		if (off.length > 0) {
			fail("tool_histogram_mismatch", off.map((s) => `${s.n}:${JSON.stringify(histogramOf(s.tool_events))}`).join(" "));
		}
	}
	const errors = events.filter((event) => event.isError !== false);
	if (errors.length > 0) fail("tool_error", `${errors.length} tool events not isError:false`);
	const compactions = Array.isArray(report.compactions) ? report.compactions : [];
	const succeeded = new Set(compactions.filter((entry) => entry.success === true).map((entry) => entry.n));
	const missing = details.filter((session) => !succeeded.has(session.n)).map((session) => session.n);
	if (missing.length > 0) fail("compaction_failed", `sessions without a successful compact: ${missing.join(",")}`);
}

function checkMeasurements(report, fail) {
	const opens = Array.isArray(report.big_opens) ? report.big_opens : [];
	const failedOpens = opens.filter((open) => open.ok !== true);
	if (failedOpens.length > 0) fail("big_open_failed", failedOpens.map((open) => open.file).join(","));
	const memory = report.memory ?? {};
	const nullPhases = REQUIRED_PHASES.filter((phase) => typeof memory[phase]?.server_mb !== "number");
	if (nullPhases.length > 0) fail("snapshot_null", `phases without a server measurement: ${nullPhases.join(",")}`);
	if (report.server?.verified !== true) fail("pid_unverified", report.server?.reason ?? "server pid not verified");
	const missing = [];
	if (!(report.probe?.count > 0)) missing.push("probe");
	if (!(report.cpu?.server?.total_samples > 0)) missing.push("cpu.server");
	if (missing.length > 0) fail("measurement_missing", missing.join(","));
}

/** `{ pass, failures: [{ reason, detail }] }`; `pass` holds only with zero failures. */
export function evaluateValidity(report) {
	const failures = [];
	const fail = (reason, detail) => failures.push({ reason, detail });
	if (report === null || typeof report !== "object") {
		fail("measurement_missing", "report is not an object");
		return { pass: false, failures };
	}
	checkSessions(report, fail);
	checkMeasurements(report, fail);
	return { pass: failures.length === 0, failures };
}
