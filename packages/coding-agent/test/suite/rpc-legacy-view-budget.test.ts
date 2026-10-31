import { afterEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../src/modes/rpc/socket-peer-recovery.ts";

// Part of #4272 (S07a, senpi#4530 fold, design section 3): an attach baseline's frames are charged against the
// peer's byte budget like the replay lines they replace, so an oversized baseline still sheds a resync peer and
// overflows a plain one, in both shed modes.

afterEach(() => vi.unstubAllEnvs());

const BUDGET = 300;
const start = { type: "message_start", message: { role: "assistant", content: "" } };
const big = { type: "message_update", message: { role: "assistant", content: "x".repeat(BUDGET) } };

function latePeer(writer: SessionEventWriter, id: string, capabilities: readonly string[]) {
	const lines: string[] = [];
	const closed = vi.fn();
	writer.registerConnection(
		id,
		{ writeRaw: (line) => void lines.push(line), waitForBackpressure: async () => {}, close: closed },
		{ maxQueueBytes: BUDGET },
	);
	if (capabilities.length > 0) writer.setConnectionCapabilities(id, capabilities);
	return { lines, closed, types: () => lines.map((line) => (JSON.parse(line) as { type: string }).type) };
}

it("a plain peer whose baseline frame exceeds its budget gets the overflow notice and is closed", async () => {
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection("live", { writeRaw: () => {}, waitForBackpressure: async () => {} });
	writer.attachConnectionToSession("live", "s");
	writer.enqueue("s", start);
	writer.enqueue("s", big);
	const plain = latePeer(writer, "plain", []);
	writer.attachConnectionToSession("plain", "s");
	await writer.flush();
	expect(plain.types()).toEqual(["message_start", "overflow"]);
	expect(plain.closed).toHaveBeenCalledTimes(1);
	expect(writer.openLegacyViews).toBe(0);
	writer.unregisterConnection("live");
});

for (const flag of ["0", "1"]) {
	it(`a resync peer whose baseline frame exceeds its budget sheds and recovers (flag ${flag})`, async () => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", flag);
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("live", { writeRaw: () => {}, waitForBackpressure: async () => {} });
		writer.attachConnectionToSession("live", "s");
		writer.enqueue("s", start);
		writer.enqueue("s", big);
		const peer = latePeer(writer, "peer", [EVENT_RESYNC_CAPABILITY]);
		writer.attachConnectionToSession("peer", "s");
		await writer.flush();
		expect(peer.types()).toEqual(["rpc_ping", "message_start", "resync_required", "resync_required"]);
		expect(peer.closed).not.toHaveBeenCalled();
		expect(JSON.parse(peer.lines[3] ?? "{}")).toMatchObject({ sessionId: "s", reason: "overflow" });
		expect(writer.openLegacyViews).toBe(0);
		writer.unregisterConnection("live");
		writer.unregisterConnection("peer");
	});
}
