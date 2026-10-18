/**
 * Fixtures for the budgeted gc pass: where its marker lives, how to read it, and an event-ordered wait
 * for a file to be written. The wait subscribes with `fs.watchFile` (stat polling) BEFORE it checks,
 * so a write between the check and the subscription is never missed; `fs.watch` drops events on a
 * loaded macOS host.
 */
import { existsSync, unwatchFile, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import {
	type HostGcPassMarker,
	hostGcPassMarkerPath,
	parseHostGcPassMarker,
} from "../../src/modes/rpc/host-gc-pass-marker.ts";

export function gcMarkerPath(agentDir: string): string {
	return hostGcPassMarkerPath(agentDir);
}

export async function readGcMarker(agentDir: string): Promise<HostGcPassMarker> {
	const marker = parseHostGcPassMarker(await readFile(gcMarkerPath(agentDir), "utf8"));
	if (marker === undefined) throw new Error(`gc marker at ${gcMarkerPath(agentDir)} does not parse`);
	return marker;
}

export function fileWritten(path: string, timeoutMs: number): Promise<void> {
	return new Promise((resolveWritten, reject) => {
		const finish = (error?: Error): void => {
			clearTimeout(timer);
			unwatchFile(path, listener);
			if (error === undefined) resolveWritten();
			else reject(error);
		};
		const listener = (): void => {
			if (existsSync(path)) finish();
		};
		const timer = setTimeout(() => finish(new Error(`${path} was not written within ${timeoutMs}ms`)), timeoutMs);
		watchFile(path, { interval: 50 }, listener);
		listener();
	});
}
