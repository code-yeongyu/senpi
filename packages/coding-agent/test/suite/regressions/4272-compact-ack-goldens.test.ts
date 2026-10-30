import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { statusHost } from "../rpc-session-status-support.ts";
import { negotiationSockets } from "./4272-negotiation-socket-support.ts";
const directory = new URL("../../../docs/engine-socket/fixtures/compact-acks/", import.meta.url);
const index = JSON.parse(await readFile(new URL("index.json", directory), "utf8")) as {
	cases: { id: string; flag: boolean; action: string; file: string }[];
};
const PAIR = ["compact_message_updates_v1", "event_resync"];
afterEach(() => vi.unstubAllEnvs());
for (const row of index.cases)
	it(
		"T7/RULING-73 shared ACK: " + row.id,
		async () => {
			vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", row.flag ? "1" : "0");
			await using host = await statusHost();
			await using net = await negotiationSockets(host.writer, host.core.router);
			const peer = await net.connect();
			const expected = JSON.parse(await readFile(new URL(row.file, directory), "utf8")) as unknown;
			const selected = ["repeat", "session", "heartbeat", "downgrade", "no-id", "independent"].includes(row.action);
			if (selected) expect((await peer.request({ type: "set_client_info", capabilities: PAIR })).success).toBe(true);
			let sessionId: unknown;
			if (row.action === "session")
				sessionId = (await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "session" })).sessionId;
			if (row.action === "no-id") {
				const before = peer.records.length;
				peer.send({ type: "set_client_info" });
				await peer.request({ type: "get_protocol_info" });
				expect(peer.records.slice(before).filter((record) => record.command === "set_client_info")).toEqual(
					expected,
				);
			} else {
				const caps =
					row.action === "legacy" || row.action === "downgrade"
						? []
						: row.action === "incomplete"
							? [PAIR[0]]
							: row.action === "independent"
								? [...PAIR, "media_placeholders"]
								: PAIR;
				const reply = await peer.request({
					id: "h",
					type: "set_client_info",
					...(row.action === "heartbeat" || row.action === "session" ? {} : { capabilities: caps }),
					...(sessionId === undefined ? {} : { sessionId }),
				});
				expect(sessionId === undefined ? reply : { ...reply, sessionId: "<session>" }).toEqual(expected);
			}
			await peer.close();
		},
		120000,
	);
