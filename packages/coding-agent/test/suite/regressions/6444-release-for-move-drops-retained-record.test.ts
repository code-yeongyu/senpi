/**
 * senpi#6444: `release_session` tore the session down without dropping its entry in the endpoint's handover-parked
 * record, which `close_session` drops. Once the releasing host was gone, the next host on the endpoint reopened the
 * released session at startup through `reopenParked`, which opens unattended, and so wrote an `unattended` hold into
 * a file another runtime had been handed. The writer's own contract says a released file must not be reopened here
 * (`SessionEventWriter.releaseSession`).
 *
 * `release_session` takes two reasons (`session-release.ts`): `move` and `takeover`. Both hand the session to a
 * runtime outside this host, so both drop the entry. Any other reason is refused before anything changes, so the
 * session stays retained here and keeps its entry.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import {
	readHandoverParkedSessions,
	recordHandoverParkedSession,
} from "../../../src/modes/rpc/host-handover-parked.ts";
import { reopenHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-reopen.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { startReleaseHost } from "../rpc-release-host-support.ts";

const noExtension: ExtensionFactory = () => {};

type Host = Awaited<ReturnType<typeof startReleaseHost>>;

/**
 * One pass of the reopen watch the next host on this endpoint runs at startup, over the record as this host left it.
 * The record names this test process as each session's resident writer; a successor starts once that process is gone,
 * so the pass reads every entry as a gone writer leaves it (the stamp dropped).
 */
async function successorReopens(host: Host): Promise<string[]> {
	for (const entry of await readHandoverParkedSessions(host.daemonDir))
		await recordHandoverParkedSession(host.daemonDir, { ...entry, residentWriter: undefined });
	const opened: string[] = [];
	let checks = 0;
	await reopenHandoverParkedSessions(
		async (entry) => {
			opened.push(entry.sessionPath);
		},
		host.agentDir,
		host.socket,
		{ hostInstance: "successor-host", shouldReopen: () => checks++ === 0 },
	);
	return opened;
}

const entries = async (host: Host) =>
	(await readHandoverParkedSessions(host.daemonDir)).map((entry) => entry.sessionPath);

describe("a released session leaves no handover-parked entry (senpi#6444)", () => {
	it("#given a retained session #when it is released for a move #then its entry is gone and a successor on the same endpoint opens nothing", async () => {
		await using host = await startReleaseHost(noExtension, { handoverParked: true });
		host.faux.setResponses([fauxAssistantMessage("seed reply")]);
		const { sessionId } = await host.open("moved");
		expect(await entries(host)).toHaveLength(1);

		const released = await host.send({
			type: "release_session",
			id: "rel",
			sessionId,
			reason: "move",
			moveId: "move-6444",
			target: "laptop",
		});

		expect(released).toMatchObject({ success: true });
		expect(await entries(host)).toEqual([]);
		expect(await successorReopens(host)).toEqual([]);
	});

	const ends: ReadonlyArray<{
		readonly name: string;
		readonly end: (host: Host, sessionId: string, sessionPath: string) => Promise<Record<string, unknown>>;
		readonly answered: boolean;
		readonly kept: boolean;
	}> = [
		{
			name: "it is released for a takeover",
			end: (host, sessionId) => host.release(sessionId),
			answered: true,
			kept: false,
		},
		{
			name: "its last client closes it",
			end: async (host, sessionId, sessionPath) => {
				await host.attach(sessionPath, "closer");
				return host.send({ type: "close_session", id: "close", sessionId }, "closer");
			},
			answered: true,
			kept: false,
		},
		{
			name: "a release with a reason the engine does not take is refused",
			end: (host, sessionId) =>
				host.send({
					type: "release_session",
					id: "rel-unknown",
					sessionId,
					reason: "archive",
				} as unknown as RpcCommand & { id: string }),
			answered: false,
			kept: true,
		},
	];
	for (const { name, end, answered, kept } of ends) {
		it(`#given a retained session #when ${name} #then its entry is ${kept ? "kept for the next host" : "gone"}`, async () => {
			await using host = await startReleaseHost(noExtension, { handoverParked: true });
			host.faux.setResponses([fauxAssistantMessage("seed reply")]);
			const { sessionId, sessionPath } = await host.open("ended");
			expect(await entries(host)).toHaveLength(1);

			const answer = await end(host, sessionId, sessionPath);

			expect(answer).toMatchObject({ success: answered });
			expect(await entries(host)).toHaveLength(kept ? 1 : 0);
			expect(await successorReopens(host)).toHaveLength(kept ? 1 : 0);
		});
	}
});
