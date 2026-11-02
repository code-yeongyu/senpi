/**
 * Resolves once `dir/name` exists, observed with `fs.watch`. `fs.watch` on macOS starts asynchronously
 * and drops events from its startup gap, so a sentinel file is re-touched until the sentinel's OWN event
 * arrives (proof the watch is live), then existence is re-checked: a file created during the gap is never
 * missed. Readiness is never inferred from elapsed time; the re-touch only re-sends the probe.
 */
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const RETOUCH_MS = 25;

export function fileCreated(dir: string, name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const sentinelName = `.watch-ready-${randomUUID()}`;
		const sentinel = join(dir, sentinelName);
		let ready = false;
		let done = false;
		let touches = 0;
		const touch = (): void => {
			try {
				writeFileSync(sentinel, String(++touches));
			} catch (error) {
				done = true;
				clearInterval(retouch);
				watcher.close();
				reject(error);
			}
		};
		const retouch = setInterval(touch, RETOUCH_MS);
		const check = (): void => {
			if (done || !ready || !existsSync(join(dir, name))) return;
			done = true;
			watcher.close();
			rmSync(sentinel, { force: true });
			resolve();
		};
		const watcher = watch(dir, (_event, file) => {
			if (file === sentinelName && !ready) {
				ready = true;
				clearInterval(retouch);
				rmSync(sentinel, { force: true });
			}
			if (file === sentinelName || file === name) check();
		});
		touch();
	});
}
