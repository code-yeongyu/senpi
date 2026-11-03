/**
 * The fixture-start watcher: resolves ONCE on positive evidence that a fixture command started - its
 * marker file appearing (observed with `fs.watch` on the marker directory) or, on Windows, a
 * `command_started{breakaway:true}` record for the launch in the launch log. It never polls and never
 * infers a start from absence; at its deadline it fails with `fixture_start_timeout`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { QaFailure } from "./qa-failure.mjs";
import { watchDirectory } from "./watch-dir.mjs";

function breakawayStarted(launchLog, launchId) {
	if (!existsSync(launchLog)) return false;
	return readFileSync(launchLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.some((line) => {
			try {
				const record = JSON.parse(line);
				return record.type === "command_started" && record.launchId === launchId && record.breakaway === true;
			} catch {
				return false;
			}
		});
}

export function watchFixtureStart({ markerDir, marker, launchLog, launchId, deadlineMs }) {
	return new Promise((resolve, reject) => {
		const watchers = [];
		let done = false;
		const finish = (outcome) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
			outcome();
		};
		const timer = setTimeout(
			() => finish(() => reject(new QaFailure("fixture_start_timeout", `no start evidence for ${marker} in ${deadlineMs}ms`))),
			deadlineMs,
		);
		const markerPath = join(markerDir, marker);
		const checkMarker = () => {
			if (existsSync(markerPath)) finish(() => resolve({ via: "marker" }));
		};
		const onError = (error) => finish(() => reject(error));
		watchers.push(
			watchDirectory(markerDir, { onChange: (_event, name) => name === marker && checkMarker(), onReady: checkMarker, onError }),
		);
		if (launchLog !== undefined && launchId !== undefined) {
			const logName = basename(launchLog);
			const checkLog = () => {
				if (breakawayStarted(launchLog, launchId)) finish(() => resolve({ via: "command_started" }));
			};
			watchers.push(
				watchDirectory(dirname(launchLog), { onChange: (_event, name) => name === logName && checkLog(), onReady: checkLog, onError }),
			);
		}
	});
}
