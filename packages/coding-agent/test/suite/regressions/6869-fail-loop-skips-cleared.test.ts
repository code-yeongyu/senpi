import { describe, expect, it } from "vitest";
import { failQueuedFollowUps, type QueuedInputFailedEvent } from "../../../src/core/queued-input-after-error.ts";

const HOLD = { provider: "faux", message: "Your account usage limit is reached." };

describe("#6869 review L4: the fail loop works from a snapshot of the queue", () => {
	it("#given two queued follow-ups #when a clear_queue settles them while the first one's durable dequeue awaits #then only the first gets queued_input_failed", async () => {
		// given: the session's queue, and a durable dequeue that stays open until released
		const queued = new Set(["q_1", "q_2"]);
		const emitted: QueuedInputFailedEvent[] = [];
		const dequeueOpen = Promise.withResolvers<void>();
		const releaseDequeue = Promise.withResolvers<void>();
		const failing = failQueuedFollowUps(
			[
				{ queuedId: "q_1", text: "first", mode: "followUp" },
				{ queuedId: "q_2", text: "second", mode: "followUp" },
			],
			HOLD,
			{
				emit: (event) => emitted.push(event),
				isQueued: (queuedId) => queued.has(queuedId),
				dequeue: async (queuedId) => {
					if (queuedId === "q_1") {
						dequeueOpen.resolve();
						await releaseDequeue.promise;
					}
					queued.delete(queuedId);
				},
			},
		);

		// when: clear_queue lands during the first dequeue's await
		await dequeueOpen.promise;
		queued.clear();
		releaseDequeue.resolve();
		await failing;

		// then
		expect(emitted.map((event) => event.queuedId)).toEqual(["q_1"]);
	});
});
