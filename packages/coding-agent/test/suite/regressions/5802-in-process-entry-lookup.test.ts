import { afterEach, expect, it, vi } from "vitest";
import { observeInProcessOpens } from "../rpc-in-process-entry-support.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

// senpi#5802: an in-process entry is found by its session id, not by whichever registry lookup ran last. Forcing a
// later lookup of another session is the interleaving that made the old last-return lookup answer the wrong session.

afterEach(() => {
	vi.restoreAllMocks();
});

it("#5802 entryFor answers the session it names even when another session's lookup ran last, and reports the divergence", async () => {
	await using host = await statusHost();
	const admissions = observeInProcessOpens(host);
	const client = host.client("owner");
	const open = async () => String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const first = await open();
	const second = await open();
	dataOf(await client.request({ type: "get_state", sessionId: second }));
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

	const entry = admissions.entryFor(first);
	admissions.restore();

	const firstId = host.core.peekSession(first)?.durableSessionId;
	expect(firstId).not.toBe(host.core.peekSession(second)?.durableSessionId);
	expect(entry.durableSessionId).toBe(firstId);
	expect(entry.runtime?.session.sessionManager.getSessionId()).toBe(firstId);
	const reported = stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("senpi#5802"));
	expect(reported).toHaveLength(1);
	expect(JSON.parse(reported[0]?.slice(reported[0].indexOf("{")) ?? "{}")).toMatchObject({
		sessionId: first,
		spied: true,
	});
});

it("#5802 entryFor refuses a session id the host never opened, naming what the spy saw", async () => {
	await using host = await statusHost();
	const admissions = observeInProcessOpens(host);

	expect(() => admissions.entryFor("rpc-missing")).toThrow(/senpi#5802 no in-process session: .*"entry":null/);
	admissions.restore();
});
