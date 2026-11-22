/**
 * senpi#5808: a session opened over a delegated connection (a relay host forwarding one remote viewer, senpi#5632)
 * must outlive that connection. The relay host gives each viewer its own delegated connection, so the viewer leaving
 * ends the connection that sent `open_session`; the session must stay attachable from the next connection instead of
 * being closed with it, also when the viewer leaves while its open is still running.
 *
 * Runs a real host, bare and behind its supervisor, through the public-key filter.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	authenticate,
	HOST_TEST_TIMEOUT_MS,
	launchHost,
	Peer,
	sandbox,
	teardown,
	type Wire,
} from "../rpc-public-auth-harness.ts";

const DEADLINE_MS = 20_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function host(path: "bare" | "direct") {
	const qa = await sandbox();
	cleanups.push(() => teardown(qa.root));
	const running = await launchHost(qa, path, false);
	cleanups.push(() => teardown(qa.root, running.child));
	return qa;
}

async function peer(socketPath: string) {
	const result = await Peer.connect(socketPath, { deadlineMs: DEADLINE_MS });
	cleanups.push(async () => {
		result.socket.destroy();
		await result.closed;
	});
	return result;
}

async function delegated(socketPath: string, agentDir: string, conn: string) {
	const viewer = await peer(socketPath);
	expect(await authenticate(viewer, agentDir)).toMatchObject({ success: true });
	expect(
		await viewer.request({
			id: "declare",
			type: "declare_delegation",
			principal: { deviceId: "x5808-device", conn },
			granted: ["observe", "drive", "thread"],
		}),
	).toMatchObject({ success: true });
	return viewer;
}

const OPEN_LINE = `${JSON.stringify({ id: "open", type: "open_session" })}\n`;

/** `answered`: the viewer leaves after its open's response; `mid_open`: in the same write as the open. */
async function openAndLeave(opener: Peer, leave: "answered" | "mid_open"): Promise<void> {
	if (leave === "mid_open") opener.socket.end(OPEN_LINE);
	else {
		const answered = opener.waitFor((record) => record.id === "open");
		opener.socket.write(OPEN_LINE);
		expect(await answered).toMatchObject({ success: true });
		opener.socket.destroy();
	}
	await opener.closed;
}

describe.skipIf(process.platform === "win32")(
	"a session opened on a delegated connection outlives it (#5808)",
	{ timeout: HOST_TEST_TIMEOUT_MS * 2 },
	() => {
		for (const path of ["bare", "direct"] as const)
			for (const leave of ["answered", "mid_open"] as const)
				it(`${path}, opener leaves ${leave}: the next connection attaches and reads the session`, async () => {
					const qa = await host(path);
					const observer = await peer(qa.socket);
					expect(await observer.request({ id: "sub", type: "subscribe_sessions" })).toMatchObject({
						success: true,
					});

					await openAndLeave(await delegated(qa.socket, qa.agentDir, "c1"), leave);
					const opened = await observer.waitFor((record) => record.type === "session_opened");
					const sessionId = String(opened.sessionId);
					expect(
						await observer.waitFor(
							(record) =>
								record.type === "session_status" &&
								record.sessionId === sessionId &&
								(record.lastChange as Wire | undefined)?.cause === "detach",
						),
					).toMatchObject({ status: "idle", attachments: 0 });

					const next = await delegated(qa.socket, qa.agentDir, "c2");
					expect(
						await next.request({
							id: "attach",
							type: "attach_session",
							sessionId,
							durableSessionId: opened.durableSessionId,
						}),
					).toMatchObject({ success: true, data: { sessionId, attached: true } });
					expect(await next.request({ id: "state", type: "get_state", sessionId })).toMatchObject({
						success: true,
						data: { sessionId: opened.durableSessionId },
					});
					const listed = await next.request({ id: "list", type: "list_sessions" });
					expect((listed.data as { sessions: Wire[] }).sessions).toContainEqual(
						expect.objectContaining({ sessionId, attachments: 1, retain_on_disconnect: true }),
					);
				});
	},
);
