/**
 * Reads a session's `launches.jsonl` (the server-owned launch log under `<agentDir>/tool-children/<durableSessionId>`)
 * and waits for records in it. The directory appears only when the session's tool child first starts, so the wait
 * watches the agent dir recursively and re-reads on every change: no polling, and a bounded deadline per wait.
 */
import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { QaFailure } from "./qa-failure.mjs";

export function launchLog(agentDir, durableSessionId) {
	const path = join(agentDir, "tool-children", durableSessionId, "launches.jsonl");
	const read = () =>
		existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) => JSON.parse(line))
			: [];
	return {
		path,
		read,
		/** Resolves with the `nth` (1-based) record matching `predicate`. */
		waitForNth(predicate, nth, options) {
			let count = 0;
			return this.waitFor((record) => predicate(record) && ++count === nth, options, () => {
				count = 0;
			});
		},
		waitFor(predicate, { name, deadlineMs = 30_000 }, beforeScan = () => {}) {
			const found = () => {
				beforeScan();
				return read().find(predicate);
			};
			const now = found();
			if (now !== undefined) return Promise.resolve(now);
			return new Promise((resolve, reject) => {
				const watcher = watch(agentDir, { recursive: true }, () => {
					const record = found();
					if (record === undefined) return;
					clearTimeout(timer);
					watcher.close();
					resolve(record);
				});
				const timer = setTimeout(() => {
					watcher.close();
					reject(new QaFailure("record_timeout", `${name} not in ${path} within ${deadlineMs} ms`));
				}, deadlineMs);
				// A record written between the first read and the watch start is caught here.
				const raced = found();
				if (raced !== undefined) {
					clearTimeout(timer);
					watcher.close();
					resolve(raced);
				}
			});
		},
	};
}
