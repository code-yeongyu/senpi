import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { statusHost } from "../rpc-session-status-support.ts";
import { negotiationSockets } from "./4272-negotiation-socket-support.ts";
import type { WireRecord } from "./4272-worker-acceptance-support.ts";
const directory = new URL("../../../docs/engine-socket/fixtures/client-info-ack/", import.meta.url);
const index = JSON.parse(await readFile(new URL("index.json", directory), "utf8")) as {
	cases: { id: string; file: string }[];
};
const PAIR = ["compact_message_updates_v1", "event_resync"];
interface AckFixture {
	flag: boolean;
	selected?: boolean;
	session?: boolean;
	unsupported?: boolean;
	advertisement?: boolean;
	request: WireRecord;
	expectedAck: WireRecord | null;
}
afterEach(() => vi.unstubAllEnvs());
for (const row of index.cases)
	it(
		"T7/RULING-73 shared ACK: " + row.id,
		async () => {
			const fixture = JSON.parse(await readFile(new URL(row.file, directory), "utf8")) as AckFixture;
			vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", fixture.flag ? "1" : "0");
			await using host = await statusHost(fixture.unsupported ? { supportsCompact: () => false } : {});
			await using net = await negotiationSockets(host.writer, host.core.router);
			const peer = await net.connect();
			if (fixture.selected)
				expect((await peer.request({ type: "set_client_info", capabilities: PAIR })).success).toBe(true);
			let sessionId: unknown;
			if (fixture.session)
				sessionId = (await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "session" })).sessionId;
			if (fixture.expectedAck === null) {
				const before = peer.records.length;
				peer.send({ ...fixture.request, ...(sessionId === undefined ? {} : { sessionId }) });
				await peer.request(
					sessionId === undefined ? { type: "get_protocol_info" } : { type: "get_state", sessionId },
				);
				expect(peer.records.slice(before).filter((record) => record.command === "set_client_info")).toEqual([]);
			} else {
				const reply = await peer.request({ ...fixture.request, ...(sessionId === undefined ? {} : { sessionId }) });
				if (fixture.advertisement) {
					const data = reply.data as { capabilities: string[] };
					expect({ capabilities: data.capabilities.filter((cap) => PAIR.includes(cap)) }).toEqual(
						fixture.expectedAck,
					);
				} else
					expect(sessionId === undefined ? reply : { ...reply, sessionId: "<session>" }).toEqual(
						fixture.expectedAck,
					);
			}
			await peer.close();
		},
		120000,
	);
