import { captureGlobalBaseline, largestGlobals } from "./worker-global-sizes.js";
import { createHeapProbe } from "./worker-heap.js";

const MIB = 1024 * 1024;
const MIN_GROWTH_BYTES = 64 * MIB;
const GROWTH_RATIO = 0.25;
const NOTICE_GROWTH_RATIO = 1.25;
const IDLE_COLLECT_DELAY_MS = 1_000;
// A full collection costs at most 1/20 of the time since the previous one.
const COLLECT_RATE_FLOOR = 20;
const REPORTED_GLOBALS = 5;

/**
 * Post-cell memory policy of one JS kernel worker (thresholds come from `init`):
 * - a settled cell whose heap estimate reached the ceiling, grew past the watermark by more than
 *   max(64 MiB, 25%) since the last measurement, or crossed the notice line upward (or grew 25% past it)
 *   gets a synchronous full collection before its result is sent, and the result reports the live size;
 * - after any cell that leaves at least the watermark live, an idle full collection runs about a second
 *   later unless the next run, interrupt, or close arrives first: a cell that only drops a global
 *   allocates nothing, so nothing else would ever notice the garbage. Runtimes that collect idle
 *   threads themselves (Bun 1.4.3+) skip this; the post-cell measurement above still runs everywhere.
 */
export function createWorkerMemory(thresholds, onIdleCollected, { heap = createHeapProbe(), now = () => performance.now() } = {}) {
	let baseline = new Set();
	let lastLive = 0;
	let noticeRef = 0;
	let lastCollectEnd = Number.NEGATIVE_INFINITY;
	let lastCollectMs = 0;
	let idleTimer = null;

	function collect() {
		const startedAt = now();
		const live = heap.collect();
		lastCollectEnd = now();
		lastCollectMs = lastCollectEnd - startedAt;
		lastLive = live;
		if (live < thresholds.noticeBytes / 2) noticeRef = 0;
		return live;
	}

	function needsCollection(estimate) {
		const { gcWatermarkBytes, noticeBytes, ceilingBytes } = thresholds;
		if (ceilingBytes > 0 && estimate >= ceilingBytes) return true;
		if (gcWatermarkBytes > 0 && estimate >= gcWatermarkBytes) {
			if (estimate > lastLive + Math.max(MIN_GROWTH_BYTES, lastLive * GROWTH_RATIO)) return true;
		}
		if (noticeBytes === 0 || estimate < noticeBytes) return false;
		return lastLive < noticeBytes || noticeRef === 0 || estimate >= noticeRef * NOTICE_GROWTH_RATIO;
	}

	function worthNaming(live) {
		const { noticeBytes, ceilingBytes } = thresholds;
		return (noticeBytes > 0 && live >= noticeBytes) || (ceilingBytes > 0 && live >= ceilingBytes);
	}

	function cancelIdle() {
		if (idleTimer !== null) clearTimeout(idleTimer);
		idleTimer = null;
	}

	function scheduleIdle() {
		if (!heap.idleCollection || thresholds.gcWatermarkBytes === 0 || lastLive < thresholds.gcWatermarkBytes) return;
		const floorEnd = lastCollectEnd + COLLECT_RATE_FLOOR * lastCollectMs;
		const delayMs = Math.max(IDLE_COLLECT_DELAY_MS, floorEnd - now());
		idleTimer = setTimeout(() => {
			idleTimer = null;
			onIdleCollected({ liveBytes: Math.round(collect()), measure: "heap" });
		}, delayMs);
		idleTimer.unref?.();
	}

	return {
		captureBaseline() {
			baseline = captureGlobalBaseline();
		},
		cancelIdle,
		afterCell() {
			cancelIdle();
			let liveBytes = heap.estimate();
			const gcRan = heap.canCollect && needsCollection(liveBytes);
			if (gcRan) liveBytes = collect();
			const noticeLevel = gcRan && thresholds.noticeBytes > 0 && liveBytes >= thresholds.noticeBytes;
			if (noticeLevel && (noticeRef === 0 || liveBytes >= noticeRef * NOTICE_GROWTH_RATIO)) noticeRef = liveBytes;
			const globals = gcRan && worthNaming(liveBytes) ? largestGlobals(baseline, REPORTED_GLOBALS) : [];
			scheduleIdle();
			return {
				liveBytes: Math.round(liveBytes),
				measure: "heap",
				...(gcRan ? { gcRan: true } : {}),
				...(globals.length > 0 ? { globals } : {}),
			};
		},
	};
}
