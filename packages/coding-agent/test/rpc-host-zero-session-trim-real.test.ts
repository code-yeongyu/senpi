/**
 * A REAL Bun host whose sessions each held 100 MiB returns that memory once its last session closes:
 * it collects and says so with `host_trimmed`, instead of idling at its peak footprint for the whole
 * idle window. The record is subscribed to BEFORE the last close is sent.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bunFootprint, bunFootprintBytes, bunHost } from "./helpers/rpc-bun-host.ts";
import { JsonlPeer, openedSessionId } from "./helpers/rpc-generation-support.ts";
import { endpointScratch, hostChildren, sweepEndpointScratches, tracked } from "./helpers/rpc-host-endpoint-scratch.ts";

const MEGABYTE = 1024 * 1024;

const ALLOCATING_EXTENSION = `export default function (pi) {
	let held;
	pi.rpc.handle("probe.alloc", () => {
		held = new Uint8Array(${100 * MEGABYTE});
		held.fill(1);
		return { bytes: held.length };
	});
}`;

afterEach(sweepEndpointScratches, 180_000);

describe.skipIf(process.platform === "win32")("zero-session trim on a real host", () => {
	it("collects once the last of three 100 MiB sessions closes, returning at least half of their growth", async () => {
		const qa = endpointScratch("trim");
		const extension = join(qa.root, "alloc.mjs");
		await writeFile(extension, ALLOCATING_EXTENSION);
		const supervisor = await bunHost(qa, qa.legacy, extension);
		const [host] = hostChildren(supervisor);
		if (host === undefined) throw new Error("the supervisor has no host child");
		const client = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(client);
		const baseline = await bunFootprintBytes(host);

		const sessions: string[] = [];
		for (const index of [0, 1, 2]) {
			const opened = await client.request({ id: `open-${index}`, type: "open_session", cwd: qa.cwd });
			const sessionId = openedSessionId(opened);
			sessions.push(sessionId);
			const reply = await client.request({
				id: `alloc-${index}`,
				type: "extension_request",
				name: "probe.alloc",
				sessionId,
			});
			expect(reply.success).toBe(true);
		}
		const peak = await bunFootprintBytes(host);
		if (baseline === undefined || peak === undefined) throw new Error("host footprint unreadable");
		expect(peak - baseline).toBeGreaterThanOrEqual(250 * MEGABYTE);

		for (const [index, sessionId] of sessions.slice(0, 2).entries()) {
			await client.request({ id: `close-${index}`, type: "close_session", sessionId });
		}
		const trimmed = client.waitFor((record) => record.type === "host_trimmed", 15_000);
		await client.request({ id: "close-2", type: "close_session", sessionId: sessions[2] });
		const record = await trimmed;

		expect(record).toMatchObject({ type: "host_trimmed", collected: true });
		// The measure is whatever this platform's footprint reader reports for the host
		// (phys_footprint on darwin, rss_anon on linux): pin that contract, not one string.
		// Read it through the same bun child as the baseline/peak bytes: this test may run
		// under node, where a direct readProcessFootprint(host) cannot bind the FFI reader.
		const hostMeasure = (await bunFootprint(host))?.measure;
		if (hostMeasure === undefined) throw new Error("host footprint unreadable");
		expect(record.measure).toBe(hostMeasure);
		const { footprintBeforeMb, footprintAfterMb } = record;
		if (typeof footprintBeforeMb !== "number" || typeof footprintAfterMb !== "number")
			throw new Error("no footprint");
		expect(footprintBeforeMb - footprintAfterMb).toBeGreaterThanOrEqual((peak - baseline) / MEGABYTE / 2);
		const after = await bunFootprintBytes(host);
		if (after === undefined) throw new Error("host footprint unreadable after the trim");
		const mb = (bytes: number): string => (bytes / MEGABYTE).toFixed(1);
		console.info(
			`host footprint MiB: baseline ${mb(baseline)}, peak ${mb(peak)}, after trim ${mb(after)}; record ${JSON.stringify(record)}`,
		);
		expect(peak - after).toBeGreaterThanOrEqual((peak - baseline) / 2);
		expect(client.messages.filter((message) => message.type === "host_trimmed")).toHaveLength(1);
	}, 180_000);
});
