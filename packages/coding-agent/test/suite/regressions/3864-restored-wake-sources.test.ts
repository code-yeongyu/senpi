import { expect, it } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { WorkCustodyRecord } from "../../../src/core/work-custody-record.ts";
import { SessionWorkObligations } from "../../../src/core/work-obligations.ts";

// senpi#3864 review (#3963): a wake source restored from the journal has no producer after a restart
// unless that producer publishes again; it must not hold the session in a waiting state forever.
function restoredFrom(record: WorkCustodyRecord): SessionWorkObligations {
	const entry: SessionEntry = {
		type: "custom",
		customType: "work-custody",
		data: record,
		id: "custody-1",
		parentId: null,
		timestamp: "2026-10-22T00:00:00.000Z",
	};
	return new SessionWorkObligations({ entries: [entry], append: () => {}, changed: () => {} });
}
const monitor: WorkCustodyRecord = {
	id: "wake-1",
	key: "wake-source:monitor",
	source: "monitor",
	kind: "background",
	activeCount: 2,
	state: "open",
};

it("retires a restored wake source whose producer did not publish again", () => {
	// Given a journal with an open wake source from before the restart.
	const obligations = restoredFrom(monitor);

	// When recovery finishes without that producer publishing.
	obligations.retireRestoredSources();

	// Then nothing holds the session open.
	expect(obligations.activeCount).toBe(0);
});

it("keeps a restored wake source its producer published again", () => {
	// Given the same journal, and the producer reports one live item after the restart.
	const obligations = restoredFrom(monitor);
	obligations.syncSource("monitor", "background", 1);

	// When recovery finishes.
	obligations.retireRestoredSources();

	// Then the republished count stands.
	expect(obligations.active).toEqual([expect.objectContaining({ key: "wake-source:monitor", activeCount: 1 })]);
});
