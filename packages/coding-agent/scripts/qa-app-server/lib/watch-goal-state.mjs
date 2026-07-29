import { readFileSync, watch } from "node:fs";
import { join } from "node:path";

export function watchForGoalState(
	sessionDir,
	threadId,
	predicate,
	label,
	timeoutMs = 90_000,
	{ watchImpl = watch, readFileImpl = readFileSync } = {},
) {
	const root = join(sessionDir, "extensions", "goal");
	const fileName = `${encodeURIComponent(threadId)}.json`;
	const goalFile = join(root, fileName);
	return new Promise((resolve, reject) => {
		let settled = false;
		const watcher = watchImpl(root, (_event, changedFile) => {
			if (changedFile !== fileName) return;
			try {
				const goal = JSON.parse(readFileImpl(goalFile, "utf8")).goal;
				if (predicate(goal)) finish(undefined, goal);
			} catch (error) {
				if (error?.code !== "ENOENT") finish(error);
			}
		});
		const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), timeoutMs);
		watcher.once("error", finish);

		function finish(error, goal) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			watcher.close();
			if (error) reject(error);
			else resolve(goal);
		}
	});
}
