import { afterEach, expect, it, vi } from "vitest";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { heldPeer } from "./4272-legacy-view-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S08b, review MEDIUM at 90f5e36b0b and 5b90366433): the shed's resync cut owns its root from the
// freeze until its gap is delivered; a detach, re-attach or supersession meanwhile retires the token, never the root.

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("review MEDIUM a detach and re-attach between the shed's freeze and the delivery of its gap, before anything reads the cut, keeps the cut's root: the cut's message, no closed flag, no stderr line", async () => {
	vi.useFakeTimers();
	const { writer, lane, checkpoints, producer, attach } = recoveryRig();
	const held = heldPeer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
	await attach(held);
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const reads = vi.spyOn(lane, "readCurrentActive");
	held.hold();
	for (let index = 0; index < 200 && checkpoints.open === 0; index++) producer().blockDelta("text", 0, "x", index);
	expect(checkpoints.open, "the shed froze its cut").toBe(1);
	writer.detachConnectionFromSession("held", "s");
	writer.attachConnectionToSession("held", "s");
	expect(reads, "nothing has read the cut yet").not.toHaveBeenCalled();
	expect(checkpoints.status().reclaimed, "the detach retired the cut's token").toBe(1);
	expect(lane.liveRoots, "the cut keeps its root until its gap is delivered").toBe(1);
	held.release();
	await writer.flush();
	const resync = held.lines.find((line) => line.includes('"resync_required"') && line.includes('"sessionId":"s"'));
	const frame = JSON.parse(resync ?? "{}");
	expect(frame, "the cut's active message, as at the S08a base").toMatchObject({
		sessionId: "s",
		message: { role: "assistant", content: [{ type: "text" }] },
	});
	expect(frame.message.content[0].text).toMatch(/^x+$/);
	expect(frame).not.toHaveProperty("closed");
	expect(stderr.mock.calls.filter(([line]) => String(line).includes("legacy view"))).toEqual([]);
	expect(checkpoints.open).toBe(0);
	expect(lane.liveRoots, "the delivery released the cut's root").toBe(0);
	writer.unregisterConnection("held");
	lane.retire("close");
	await lane.idle();
});

it.each(["as the lane read starts (inside the hold)", "while the lane read is pending"] as const)(
	"review MEDIUM a detach and re-attach %s keeps the shed's resync root until its read unwinds: the cut's message, no closed flag, no stderr line",
	async (timing) => {
		vi.useFakeTimers();
		const { writer, lane, checkpoints, producer, attach } = recoveryRig();
		const held = heldPeer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
		await attach(held);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const read = lane.readCurrentActive.bind(lane);
		let raced = false;
		vi.spyOn(lane, "readCurrentActive").mockImplementation(async (root) => {
			if (raced) return read(root);
			raced = true;
			const reattach = () => {
				writer.detachConnectionFromSession("held", "s");
				writer.attachConnectionToSession("held", "s");
			};
			if (timing === "as the lane read starts (inside the hold)") {
				reattach();
				return read(root);
			}
			const pending = read(root);
			reattach();
			return pending;
		});
		held.hold();
		for (let index = 0; index < 200 && checkpoints.open === 0; index++) producer().blockDelta("text", 0, "x", index);
		expect(checkpoints.open, "the shed froze its cut").toBe(1);
		held.release();
		await writer.flush();
		expect(raced, "the resync read raced the re-attach").toBe(true);
		const resync = held.lines.find((line) => line.includes('"resync_required"') && line.includes('"sessionId":"s"'));
		const frame = JSON.parse(resync ?? "{}");
		expect(frame, "the cut's active message, as at the S08a base").toMatchObject({
			sessionId: "s",
			message: { role: "assistant", content: [{ type: "text" }] },
		});
		expect(frame.message.content[0].text).toMatch(/^x+$/);
		expect(frame).not.toHaveProperty("closed");
		expect(stderr.mock.calls.filter(([line]) => String(line).includes("legacy view"))).toEqual([]);
		expect(checkpoints.open).toBe(0);
		expect(lane.liveRoots).toBe(0);
		writer.unregisterConnection("held");
		lane.retire("close");
		await lane.idle();
	},
);
