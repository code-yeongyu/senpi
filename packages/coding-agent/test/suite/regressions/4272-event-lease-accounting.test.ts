import { afterEach, expect, it, vi } from "vitest";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { FLAG } from "./4272-construction-host-support.ts";

// Part of #4272 (S13, X07): what the event-lease path costs, in totals. Two compact-events peers and one legacy peer
// receive the same session records: an oversized record is staged ONCE whatever the number of compact peers (no
// per-peer copy), each compact peer holds one descriptor per oversized record, and the 1 MiB / 1,024-update producer
// fixture (every record far under F) pins nothing and sends every peer the complete bytes. The legacy peer's bytes
// are reported beside the compact peers', never as a saving of its own.

const F = 262_144;
const wireBytes = (record: WireRecord): number => Buffer.byteLength(`${JSON.stringify(record)}\n`);
const total = (client: RawClient): number => client.inbox.reduce((sum, record) => sum + wireBytes(record), 0);
const leases = (client: RawClient) => client.inbox.filter((record) => record.eventLease !== undefined);

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("X07 S13 an oversized record is staged once for every compact peer, each holds one descriptor, and the 1 MiB / 1,024-update fixture pins nothing", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await statusHost();
	try {
		const legacy = host.client("legacy");
		const routing = String(dataOf(await legacy.request({ type: "open_session", cwd: host.cwd })).sessionId);
		const compact = ["compact-a", "compact-b"].map((name) => {
			const client = host.client(name);
			host.writer.setConnectionCapabilities(name, ["compact_events"]);
			host.writer.attachConnectionToSession(name, routing);
			return client;
		});
		const events = host.writer.recoveryEvents ?? expect.unreachable("no event lease owner with the flag on");
		const before = compact.map(total);
		const legacyBefore = total(legacy);
		for (let update = 0; update < 1024; update++)
			host.writer.enqueue(routing, { type: "queue_update", steering: [`u${update} ${"q".repeat(1000)}`] });
		await host.writer.flush();
		expect(events.status(), "records under F lease and pin nothing").toMatchObject({
			open: 0,
			minted: 0,
			contentBytes: 0,
		});
		const smallLegacy = total(legacy) - legacyBefore;
		expect(smallLegacy).toBeGreaterThan(1024 * 1000);
		for (const [index, client] of compact.entries())
			expect(total(client) - (before[index] ?? 0), "small records reach compact peers byte for byte").toBe(
				smallLegacy,
			);
		const records = 3;
		const text = (index: number) => String(index).repeat(300_000);
		for (let index = 0; index < records; index++)
			host.writer.enqueue(routing, {
				type: "tool_execution_end",
				toolCallId: `c${index}`,
				result: { content: [{ type: "text", text: text(index) }] },
			});
		await host.writer.flush();
		const legacyLarge = legacy.inbox.filter((record) => record.type === "tool_execution_end").map(wireBytes);
		expect(legacyLarge.every((bytes) => bytes > F)).toBe(true);
		const stored = legacyLarge.reduce((sum, bytes) => sum + 2 * (bytes - 1), 0);
		expect(events.status(), "one staged copy per record, shared by both compact peers").toMatchObject({
			open: records * compact.length,
			minted: records * compact.length,
			contentBytes: stored,
		});
		for (const client of compact) {
			expect(leases(client)).toHaveLength(records);
			expect(Math.max(...leases(client).map(wireBytes))).toBeLessThan(1024);
		}
		await host.drop("compact-a");
		expect(events.status(), "the shared copy stays while the other peer's leases hold it").toMatchObject({
			open: records,
			contentBytes: stored,
		});
		await host.drop("compact-b");
		expect(events.status()).toMatchObject({ open: 0, contentBytes: 0 });
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 300_000);
