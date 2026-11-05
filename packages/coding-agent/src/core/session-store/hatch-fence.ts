import { liveSessionHolders } from "../session-holders.ts";
import { advanceSessionFence } from "../session-write-fence.ts";

/**
 * DRIFT A (senpi#5822): the durable store advances a session file's write fence only against a live foreign holder that
 * writes through the Node developer hatch, so that writer's next write gets today's SessionFencedError. A Bun holder is
 * never fenced here; it keeps today's warn-and-continue. Returns whether the fence moved.
 */
export async function fenceHatchWriters(sessionFile: string, sessionId: string): Promise<boolean> {
	const holders = await liveSessionHolders(sessionFile, sessionId);
	if (!holders.some((holder) => holder.k9f2 === true && holder.pid !== process.pid)) return false;
	await advanceSessionFence(sessionFile);
	return true;
}
