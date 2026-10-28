import { afterEach, expect, it, vi } from "vitest";
import { FRAGMENT_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { TRANSFER_STAGING_MAX_BYTES } from "../../../src/modes/rpc/compact-transfer-staging.ts";
import { within, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

/** Code units one fragment carries: D stored bytes, two per UTF-16 code unit. */
const UNITS = FRAGMENT_MAX_BYTES / 2;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// Part of #4272, RULING-80 (3a): a staging refusal while a worker message is being transferred stays a typed failure of
// the whole incarnation (fail-closed), but the failure names the cause and the event, the host records it, and the
// session's clients are told: never a silent worker loss.
it.each([
	{
		cause: "fragment_over_limit",
		// Mid-transfer: the first fragment is staged, the second is longer than D.
		length: 4 * FRAGMENT_MAX_BYTES,
		pieces: [UNITS, UNITS + 1],
	},
	{
		cause: "staging_over_byte_limit",
		// The first fragment declares more than the staging bound may hold.
		length: TRANSFER_STAGING_MAX_BYTES + FRAGMENT_MAX_BYTES,
		pieces: [UNITS],
	},
])(
	"S12b RULING-80 (3a) $cause: the typed failure names cause and event, the host records it, the client hears it",
	async ({ cause, length, pieces }) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		const host = await workerAcceptanceHost();
		try {
			const { worker } = await host.open();
			const lane = worker.acceptance;
			const intake = worker.intake;
			if (!lane || !intake) throw new Error("flag on: the worker client owns a lane and an intake");
			const before = lane.freeze();
			lane.release(before);
			const first = intake.nextOrdinal;
			const commit = first + Math.ceil(length / FRAGMENT_MAX_BYTES) - 1;
			let offset = 0;
			for (const [index, units] of pieces.entries()) {
				worker.worker.emit("message", {
					type: "fragment",
					of: "output",
					length,
					offset,
					text: "x".repeat(units),
					ordinal: first + index,
				});
				offset += units * 2;
			}
			await within("worker incarnation exits", worker.exited);
			const error = `session_worker_transfer_${cause}: output ordinal ${commit} (${length} stored bytes)`;
			expect(host.failures, "the typed failure names the cause and the event").toEqual([error]);
			expect(intake.refusal, "the host recorded the refusal").toEqual({
				cause,
				event: { type: "output", ordinal: commit, length },
			});
			expect(host.records, "the session's clients were told").toContainEqual(
				expect.objectContaining({ type: "session_error", error }),
			);
			expect(lane.retired, "fail-closed: the whole incarnation ends").toBe(true);
			expect(lane.freeze().sequence, "nothing was accepted").toBe(before.sequence);
			expect(lane.storageStatus().transcript.openTransfers, "nothing stays staged").toBe(0);
		} finally {
			await host.dispose();
		}
	},
	120_000,
);
