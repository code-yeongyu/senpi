import { mkdir } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { CompactLaneCurrent } from "../../../src/modes/rpc/compact-lane-current.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { removeSpoolDir } from "../../../src/modes/rpc/compact-spool-dir.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#6068: a compact current state whose storage retire fails (here the spool directory refuses its reclaim) is
// reported once on stderr and never becomes an unhandled rejection of the host process; whoever joins the lane's
// cleanup through idle() still sees the failure.

const REPORT = "senpi rpc acceptance: compact current state retire failed: marker_missing\n";

afterEach(() => {
	vi.restoreAllMocks();
});

async function retireRefused(end: (current: CompactLaneCurrent) => void) {
	const root = await spoolRoot();
	await mkdir(root.dir, { recursive: true });
	const refusal: unknown = await removeSpoolDir(root.dir, "unmarked").catch((cause: unknown) => cause);
	expect(refusal).toMatchObject({ name: "CompactSpoolRefusedError", reason: "marker_missing" });
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		vi.spyOn(CompactSessionState.prototype, "retire").mockRejectedValueOnce(refusal);
		const current = new CompactLaneCurrent();
		current.bootstrap({ dir: root.dir, epoch: "A" });
		end(current);
		// The runtime reports an unhandled rejection once the microtask queue drains, before the next macrotask runs.
		await new Promise<void>((resolve) => setImmediate(resolve));
		const lines = write.mock.calls.map(([chunk]) => String(chunk));
		await expect(current.idle(), "a joiner still sees the failed retire").rejects.toBe(refusal);
		return { unhandled, lines };
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await root.cleanup();
	}
}

it("retire(): a refused storage retire is reported once and is not an unhandled rejection", async () => {
	const { unhandled, lines } = await retireRefused((current) => current.retire());
	expect(unhandled).toEqual([]);
	expect(lines.filter((line) => line === REPORT)).toHaveLength(1);
});

it("fail(): the state it ends reports a refused retire the same way", async () => {
	const { unhandled, lines } = await retireRefused((current) => current.fail(new Error("fold failed")));
	expect(unhandled).toEqual([]);
	expect(lines).toContain("senpi rpc acceptance: compact current state unavailable: Error: fold failed\n");
	expect(lines.filter((line) => line === REPORT)).toHaveLength(1);
});
