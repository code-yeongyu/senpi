/**
 * A directory watch with an event-proven start. `fs.watch` on macOS starts its FSEvents stream
 * asynchronously and drops events from that startup gap (measured: Node misses the first write, Bun
 * the first two), so a single readiness probe can itself be lost. The watcher therefore re-touches a
 * sentinel file until the sentinel's OWN event arrives, which proves the stream is live, then calls
 * `onReady` so the caller re-checks for evidence created during the gap. Readiness is never inferred
 * from elapsed time; the re-touch only re-sends the probe.
 */
import { randomUUID } from "node:crypto";
import { rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const RETOUCH_MS = 25;

export function watchDirectory(dir, { onChange, onReady, onError = () => undefined }) {
	const sentinel = join(dir, `.watch-ready-${randomUUID()}`);
	const sentinelName = sentinel.slice(dir.length + 1);
	let ready = false;
	let touches = 0;
	const touch = () => {
		try {
			writeFileSync(sentinel, String(++touches));
		} catch (error) {
			clearInterval(retouch);
			watcher.close();
			onError(error);
		}
	};
	const retouch = setInterval(touch, RETOUCH_MS);
	const watcher = watch(dir, (event, name) => {
		if (name === sentinelName) {
			if (ready) return;
			ready = true;
			clearInterval(retouch);
			rmSync(sentinel, { force: true });
			onReady();
			return;
		}
		onChange(event, name);
	});
	touch();
	return {
		close() {
			clearInterval(retouch);
			watcher.close();
			rmSync(sentinel, { force: true });
		},
	};
}
