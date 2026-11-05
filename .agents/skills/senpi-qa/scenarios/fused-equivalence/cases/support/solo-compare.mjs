// E30 (plan §6.4, Z1.f) "each session equal to its single-session B0": the solo-run comparison.
//
// Each session of a multi-session run is projected onto what that session alone would see: its connection's event
// stream without today's broadcast lifecycle records of the OTHER sessions (BROADCAST_LIFECYCLE: a multi-session host
// sends every connection those, by design), plus its own transcript. The same session is then run alone in a fresh
// sandbox, fake model server and host, with only its own scripted turns, and projected the same way. Both projections
// are normalized separately and must be equal. Anything else that reaches a session from another one (a tool result,
// a message, an event type outside BROADCAST_LIFECYCLE) is kept in the projection, so a cross-session leak is a diff.
// A fresh fake server per solo run gives each run its own barriers and turn cursor, so the shared server needs no
// re-armable barriers.
import { diffNormalized } from "../../../../scripts/lib/equivalence-normalize.mjs";
import { startCaseRun } from "./case-run.mjs";
import { attachSession, closeConnections, startMultiSessionHost } from "./multi-session-host.mjs";
import { observe } from "./observe.mjs";

/** Event types a multi-session host broadcasts to every connection today (measured in the E30 B0 golden). */
const BROADCAST_LIFECYCLE = new Set([
	"session_opened",
	"session_lifecycle",
	"agent_start",
	"agent_settled",
	"agent_idle",
]);
const SOLO_OBSERVABLES = ["O6", "O7"];

const isOtherSessionBroadcast = (event, sessionId) =>
	typeof event.sessionId === "string" && event.sessionId !== sessionId && BROADCAST_LIFECYCLE.has(event.type);

/** Normalized O6/O7 of one session of `run`: its own connection's events and its own transcript. */
export function observeSession(run, connection) {
	const view = {
		box: run.box,
		repo: run.repo,
		server: run.server,
		extraRoots: run.extraRoots,
		childRuntime: run.childRuntime,
		clients: [{ events: connection.client.events.filter((e) => !isOtherSessionBroadcast(e, connection.sessionId)) }],
		sessionFile: connection.sessionFile,
		sessionIds: [connection.sessionId],
	};
	return observe(view, SOLO_OBSERVABLES);
}

/**
 * Run one session alone on its own host: `spec` is a case spec with only that session's turns; `drive(solo, connection)`
 * drives it to idle. Resolves with its normalized O6/O7.
 */
export async function runSolo(spec, label, drive) {
	const solo = await startCaseRun({ ...spec, label });
	try {
		const socket = await startMultiSessionHost(solo);
		const connection = await attachSession(solo, socket, { cwd: solo.box.cwd });
		await drive(solo, connection);
		await closeConnections([connection]);
		return observeSession(solo, connection);
	} finally {
		await solo.stop();
		solo.box.cleanup();
	}
}

/** Throw when a session of the multi-session run differs from the same session run alone; names the first rows. */
export function assertSoloEqual(name, concurrent, solo) {
	const rows = diffNormalized(solo, concurrent);
	if (rows.length === 0) return;
	const first = rows
		.slice(0, 6)
		.map(
			(row) =>
				`${row.path}: solo=${JSON.stringify(row.golden)?.slice(0, 120)} concurrent=${JSON.stringify(row.actual)?.slice(0, 120)}`,
		)
		.join("; ");
	throw new Error(`E30 solo compare: session ${name} differs from its solo run in ${rows.length} row(s): ${first}`);
}
