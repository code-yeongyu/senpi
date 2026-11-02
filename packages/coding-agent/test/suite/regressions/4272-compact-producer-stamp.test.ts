import { expect, it } from "vitest";
import { CompactProducerStamp } from "../../../src/modes/rpc/compact-producer-stamp.ts";

const carrier = (messageId: string) => ({ messageId, epoch: "e" });
const open = (stamp: CompactProducerStamp): number => {
	const first: unknown = Reflect.get(stamp, "first");
	if (!(first instanceof Map)) throw new Error("missing producer binding seam");
	return first.size;
};

// senpi#4439 review LOW-6: a message's first-ordinal binding ends with the message on every terminal path, including
// the error and abort terminals whose canonical message_end never paired, and the epoch's end.
it("drops a message's first-ordinal binding when its message ends, with or without a canonical terminal", () => {
	const stamp = new CompactProducerStamp();
	stamp.stamp(carrier("a"), { type: "message_start" });
	stamp.stamp(carrier("a"), { type: "message_end" }, { type: "message_end" });
	expect(open(stamp)).toBe(0);
	stamp.stamp(carrier("aborted"), { type: "message_start" });
	stamp.stamp(carrier("aborted"), { type: "message_update" });
	expect(open(stamp)).toBe(1);
	expect(stamp.stamp(carrier("aborted"), undefined, { type: "message_end" })).toEqual({ ordinal: 4 });
	expect(open(stamp)).toBe(0);
	stamp.stamp(carrier("replaced"), { type: "message_start" });
	stamp.forget();
	expect(open(stamp)).toBe(0);
	expect(stamp.stamp(carrier("next"), { type: "message_start" })).toEqual({ ordinal: 6, firstOrdinal: 6 });
});
