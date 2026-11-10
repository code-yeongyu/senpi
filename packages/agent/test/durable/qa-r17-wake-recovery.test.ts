// senpi#5675 (S14, QA-R17): a background wake survives a brain crash and a hand crash; the durable trace is exactly
// offer (hand) -> commit (brain) -> ack (hand) -> take (brain), and the brain's loop gets the wake once.
import { describe, expect, it } from "vitest";
import type { DurableStore, StoreWrite } from "../../src/durable/store.ts";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createWakeInbox } from "../../src/execution/wake-inbox.ts";
import { createWakeOutbox } from "../../src/execution/wake-outbox.ts";
import type { WakeEvent } from "../../src/execution/wake-types.ts";

class Crash extends Error {}

const stepOf = (writes: readonly StoreWrite[]): string => {
	const append = writes.find((write) => write.op === "append");
	const data = append?.op === "append" ? append.data : null;
	return data !== null && typeof data === "object" && "step" in data ? String(data.step) : "";
};

/** One process's view of a durable medium: every durable commit lands in `trace`; `crash` kills it around one step. */
function processStore(
	medium: MemoryStoreMedium,
	who: string,
	trace: string[],
	crash?: { readonly step: string; readonly at: "before" | "after" },
): DurableStore {
	const store = openMemoryStore(medium);
	let dead = false;
	return {
		readEpoch: () => store.readEpoch(),
		readHead: () => store.readHead(),
		claim: (expected, next) => store.claim(expected, next),
		mintId: () => store.mintId(),
		scanRecords: (query) => store.scanRecords(query),
		getDocument: (key) => store.getDocument(key),
		scanDocuments: (prefix) => store.scanDocuments(prefix),
		exportSnapshot: () => store.exportSnapshot(),
		importSnapshot: (epoch, snapshot) => store.importSnapshot(epoch, snapshot),
		commit: async (epoch, writes, adopt) => {
			const step = stepOf(writes);
			if (dead || (crash?.step === step && crash.at === "before")) {
				dead = true;
				throw new Crash(`${who} died before ${step}`);
			}
			const result = await store.commit(epoch, writes, adopt);
			trace.push(`${who}:${step}`);
			if (crash?.step === step) {
				dead = true;
				throw new Crash(`${who} died after ${step}`);
			}
			return result;
		},
	};
}

async function claimed(): Promise<MemoryStoreMedium> {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	return medium;
}

describe("QA-R17: durable wake recovery", () => {
	it("recovers a wake across a brain crash before its commit and a hand crash before its ack record", async () => {
		const trace: string[] = [];
		const handMedium = await claimed();
		const brainMedium = await claimed();
		const hand = (crash?: { readonly step: string; readonly at: "before" | "after" }) =>
			createWakeOutbox({
				hand: "h1",
				store: processStore(handMedium, "hand", trace, crash),
				epoch: 1,
				admission: createAdmissionLine(),
				clock: () => 0,
			});
		const brain = (crash?: { readonly step: string; readonly at: "before" | "after" }) =>
			createWakeInbox({
				issuer: "brain",
				store: processStore(brainMedium, "brain", trace, crash),
				epoch: 1,
				admission: createAdmissionLine(),
				clock: () => 0,
				owner: (scope) => (scope === "s" ? "h1" : undefined),
			});
		const linkTo = (inbox: ReturnType<typeof brain>) => (wake: WakeEvent) => inbox.receive("h1", wake);

		const wake = await hand().offer({ scope: "s", source: "terminal", payload: { job: "bash_1" } });
		await expect(hand().reoffer(linkTo(brain({ step: "commit", at: "before" })))).rejects.toBeInstanceOf(Crash);
		await expect(hand({ step: "ack", at: "before" }).reoffer(linkTo(brain()))).rejects.toBeInstanceOf(Crash);
		expect(await hand().reoffer(linkTo(brain()))).toBe(1);
		expect(await hand().pending()).toEqual([]);

		const taken: WakeEvent[] = [];
		expect(await brain().drain(async (got) => void taken.push(got))).toBe(1);
		expect(taken).toEqual([wake]);
		expect(trace).toEqual(["hand:offer", "brain:commit", "hand:ack", "brain:take"]);
	});
});
