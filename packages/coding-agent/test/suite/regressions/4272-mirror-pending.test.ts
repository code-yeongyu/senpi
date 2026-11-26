import { expect, it, vi } from "vitest";
import { MirrorPending, MIRROR_PENDING_LIMITS } from "../../../src/modes/rpc/compact-mirror-pending.ts";

it.each(["entries", "bytes"])("T2/X04 mirror pending enforces its %s limit before retention", (bound) => {
	const pending = new MirrorPending();
	const deliver = vi.fn();
	const drop = vi.fn();
	const line = bound === "bytes" ? "x".repeat(MIRROR_PENDING_LIMITS.bytes) : "x";
	const count = bound === "entries" ? MIRROR_PENDING_LIMITS.entries : 1;
	for (let index = 0; index < count; index++) pending.enqueue(line, deliver, drop);
	expect(pending.status().entries).toBe(count);
	pending.enqueue("x", deliver, drop);
	expect(pending.reason).toBe("admission_limit");
	expect(pending.status()).toEqual({ entries: 0, bytes: 0 });
	pending.activate();
	expect(deliver).not.toHaveBeenCalled();
	expect(drop).toHaveBeenCalledTimes(count + 1);
});

it("T2 pending activation transfers once and releases retained records", () => {
	const pending = new MirrorPending();
	const delivered: number[] = [];
	pending.enqueue("first", () => delivered.push(1));
	pending.enqueue("second", () => delivered.push(2));
	pending.activate();
	pending.activate();
	pending.enqueue("live", () => delivered.push(3));
	expect(delivered).toEqual([1, 2, 3]);
	expect(pending.status()).toEqual({ entries: 0, bytes: 0 });
});

it("T2/Y07 retirement releases pending records and prevents any later activation", () => {
	const pending = new MirrorPending();
	const deliver = vi.fn();
	const drop = vi.fn();
	pending.enqueue("pending", deliver, drop);
	pending.retire();
	pending.retire();
	pending.activate();
	pending.enqueue("late", deliver, drop);
	expect(pending.reason).toBe("attempt_cancelled");
	expect(pending.status()).toEqual({ entries: 0, bytes: 0 });
	expect(deliver).not.toHaveBeenCalled();
	expect(drop).toHaveBeenCalledTimes(2);
});
