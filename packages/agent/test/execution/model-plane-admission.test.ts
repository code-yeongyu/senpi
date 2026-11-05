// S31 (brain/hand split, design 5.6.3): the brain admits a hand's nested request only while its parent call is live
// on the lane the request came on, serves each request once, and answers a replay the same.
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { decodePlaneMessage, encodePlaneMessage, type PlaneHandler } from "../../src/execution/plane.ts";
import { MODEL_PLANE, serveModelPlane } from "../../src/execution/plane-model.ts";
import { decodeRemoteMessage, encodeRemoteMessage } from "../../src/execution/remote-protocol.ts";
import { createRemoteToolHost } from "../../src/execution/remote-tool-host.ts";
import type { TransportSide } from "../../src/transport/transport.ts";
import { assistant, cleanups, link, PROMPT, runCall } from "./model-plane-fixture.ts";

describe("model plane admission on the brain (S31)", () => {
	function rawHand(transport: TransportSide) {
		const invokes: Array<{ lane: string; executionId: string }> = [];
		const planeReplies: unknown[] = [];
		let invoked: () => void = () => {};
		const firstInvoke = new Promise<void>((resolve) => {
			invoked = resolve;
		});
		const waiters: Array<() => void> = [];
		transport.onFrame((frame) => {
			const plane = (() => {
				try {
					return decodePlaneMessage(frame.payload);
				} catch {
					return undefined;
				}
			})();
			if (plane !== undefined) {
				planeReplies.push(plane);
				for (const wake of waiters.splice(0)) wake();
				return;
			}
			const message = decodeRemoteMessage(frame.payload);
			if (message.kind === "invoke") {
				invokes.push({ lane: frame.lane, executionId: message.executionId });
				invoked();
			}
		});
		const replies = (count: number): Promise<unknown[]> =>
			new Promise((resolve) => {
				const check = (): void => {
					if (planeReplies.length >= count) resolve([...planeReplies]);
					else waiters.push(check);
				};
				check();
			});
		const settle = (executionId: string, lane: string) =>
			transport.send(
				lane,
				encodeRemoteMessage({
					kind: "settled",
					executionId,
					result: { content: [{ type: "text", text: "done" }], details: undefined, isError: false },
				}),
			);
		return { invokes, firstInvoke, replies, settle };
	}

	const request = (parent: string, childRequestId: string, body: JsonValue = PROMPT as unknown as JsonValue) =>
		encodePlaneMessage({ kind: "plane.request", parent, childRequestId, plane: MODEL_PLANE, body });

	function servedHost(brain: TransportSide, calls: { count: number }) {
		const handler: PlaneHandler = serveModelPlane(async () => {
			calls.count += 1;
			return assistant(`reply ${calls.count}`);
		});
		const host = createRemoteToolHost({
			transport: brain,
			placement: "split-local",
			planes: { [MODEL_PLANE]: handler },
		});
		cleanups.push(() => host.close());
		return host;
	}

	it("refuses a request whose parent is not a live call", async () => {
		const { brain, hand } = link();
		const calls = { count: 0 };
		servedHost(brain, calls);
		const raw = rawHand(hand);

		await hand.send("scope-a", request("no-such-call", "c1"));

		expect(await raw.replies(1)).toEqual([
			{ kind: "plane.refused", parent: "no-such-call", childRequestId: "c1", reason: "parent_terminal" },
		]);
		expect(calls.count).toBe(0);
	});

	it("refuses a request sent on another scope's lane, even naming a live parent", async () => {
		const { brain, hand } = link();
		const calls = { count: 0 };
		const host = servedHost(brain, calls);
		const raw = rawHand(hand);
		const running = runCall(host, { scopeId: "scope-a" });
		await raw.firstInvoke;
		const [{ executionId, lane }] = raw.invokes as [{ executionId: string; lane: string }];

		await hand.send("scope-b", request(executionId, "c1"));
		const replies = await raw.replies(1);
		await raw.settle(executionId, lane);
		await running;

		expect(replies).toEqual([
			{ kind: "plane.refused", parent: executionId, childRequestId: "c1", reason: "scope_lane_mismatch" },
		]);
		expect(calls.count).toBe(0);
	});

	it("serves a replayed request once and answers both copies the same", async () => {
		const { brain, hand } = link();
		const calls = { count: 0 };
		const host = servedHost(brain, calls);
		const raw = rawHand(hand);
		const running = runCall(host);
		await raw.firstInvoke;
		const [{ executionId, lane }] = raw.invokes as [{ executionId: string; lane: string }];

		await hand.send(lane, request(executionId, "c1"));
		const [first] = await raw.replies(1);
		await hand.send(lane, request(executionId, "c1"));
		const [, second] = await raw.replies(2);
		await raw.settle(executionId, lane);
		await running;

		expect(calls.count).toBe(1);
		expect(second).toEqual(first);
		expect(first).toMatchObject({ kind: "plane.reply", parent: executionId, childRequestId: "c1" });
	});

	it("ignores an abort sent on another scope's lane, even naming a live request", async () => {
		const { brain, hand } = link();
		let signal: AbortSignal | undefined;
		let release: () => void = () => {};
		let started: () => void = () => {};
		const serving = new Promise<void>((resolve) => {
			started = resolve;
		});
		const handler: PlaneHandler = serveModelPlane(
			(_request, abort) =>
				new Promise((resolve) => {
					signal = abort;
					release = () => resolve(assistant("served"));
					started();
				}),
		);
		const host = createRemoteToolHost({
			transport: brain,
			placement: "split-local",
			planes: { [MODEL_PLANE]: handler },
		});
		cleanups.push(() => host.close());
		const raw = rawHand(hand);
		const running = runCall(host, { scopeId: "scope-a" });
		await raw.firstInvoke;
		const [{ executionId, lane }] = raw.invokes as [{ executionId: string; lane: string }];

		await hand.send(lane, request(executionId, "c1"));
		await serving;
		await hand.send(
			"scope-b",
			encodePlaneMessage({ kind: "plane.abort", parent: executionId, childRequestId: "c1" }),
		);
		await hand.send("scope-b", request(executionId, "probe"));
		const [probe] = await raw.replies(1);
		const aborted = signal?.aborted;
		release();
		const [, served] = await raw.replies(2);
		await raw.settle(executionId, lane);
		await running;

		expect(probe).toMatchObject({ kind: "plane.refused", childRequestId: "probe", reason: "scope_lane_mismatch" });
		expect(aborted).toBe(false);
		expect(served).toMatchObject({ kind: "plane.reply", parent: executionId, childRequestId: "c1" });
	});

	it("refuses a request that arrives after its parent settled", async () => {
		const { brain, hand } = link();
		const calls = { count: 0 };
		const host = servedHost(brain, calls);
		const raw = rawHand(hand);
		const running = runCall(host);
		await raw.firstInvoke;
		const [{ executionId, lane }] = raw.invokes as [{ executionId: string; lane: string }];
		await raw.settle(executionId, lane);
		await running;

		await hand.send(lane, request(executionId, "late"));

		expect(await raw.replies(1)).toEqual([
			{ kind: "plane.refused", parent: executionId, childRequestId: "late", reason: "parent_terminal" },
		]);
		expect(calls.count).toBe(0);
	});
});
