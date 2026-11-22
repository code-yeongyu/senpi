/**
 * The lifecycle supervisor's own memory, measured on a REAL Bun supervisor the way an omo task shard
 * runs one: its phys_footprint two seconds after the host answered (the settled resident cost, read
 * from the kernel counter, so a loaded machine slows the run but does not move the number).
 */
import { afterEach, describe, expect, it } from "vitest";
import { bunFootprintBytes, bunHost } from "./helpers/rpc-bun-host.ts";
import { endpointScratch, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";

const MEGABYTE = 1024 * 1024;
/**
 * proc-perf-fix item 3 (todo 12). Measured base: 13.2-14.7 MiB, of which an idle Bun is 4.1 and its node
 * builtins 3.1, so a 20% cut has nothing left to remove; the ceiling keeps ~20% headroom over the base and
 * fails any return of the old CLI-parser/provider-catalog edge, which cost tens of MiB.
 */
const SUPERVISOR_FOOTPRINT_CEILING_MB = 18;
const SETTLE_AFTER_READY_MS = 2_000;

afterEach(sweepEndpointScratches, 180_000);

describe.skipIf(process.platform !== "darwin")("RPC host supervisor footprint", () => {
	it(`stays at or under ${SUPERVISOR_FOOTPRINT_CEILING_MB} MiB phys_footprint on Bun`, async () => {
		const qa = endpointScratch("sfp");
		const supervisor = await bunHost(qa, qa.legacy);
		// The measurement point, not a synchronization: the settled cost after start-up allocations.
		await new Promise((resolveSettled) => setTimeout(resolveSettled, SETTLE_AFTER_READY_MS));
		const bytes = await bunFootprintBytes(supervisor);
		if (bytes === undefined) throw new Error(`supervisor ${supervisor} footprint unreadable`);
		const footprintMb = bytes / MEGABYTE;
		console.info(`supervisor phys_footprint: ${footprintMb.toFixed(1)} MiB`);
		expect(footprintMb).toBeLessThanOrEqual(SUPERVISOR_FOOTPRINT_CEILING_MB);
	}, 180_000);
});
