import { stripAnsi } from "./common.mjs";

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";

/** Observe the renderer's synchronized-output commit, not startup logs or input echo. */
export function observeFrames() {
	let pending = "";
	let lastFrame = "";
	let failure;
	const waiters = new Set();
	const text = value => stripAnsi(value)
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[_P][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
	return {
		push(data) {
			pending += data;
			for (;;) {
				const start = pending.indexOf(BEGIN);
				if (start < 0) {
					pending = pending.slice(-BEGIN.length);
					return;
				}
				const end = pending.indexOf(END, start + BEGIN.length);
				if (end < 0) {
					pending = pending.slice(start);
					return;
				}
				lastFrame = text(pending.slice(start + BEGIN.length, end));
				pending = pending.slice(end + END.length);
				for (const waiter of [...waiters]) waiter();
			}
		},
		fail(error) {
			failure = error;
			for (const waiter of [...waiters]) waiter();
		},
		waitFor(predicate, label, timeoutMs) {
			return new Promise((resolve, reject) => {
				const finish = error => {
					clearTimeout(timer);
					waiters.delete(check);
					if (error) reject(error);
					else resolve(lastFrame);
				};
				const check = () => {
					if (predicate(lastFrame)) finish();
					else if (failure) finish(failure);
				};
				const timer = setTimeout(() => finish(new Error(
					`TUI ${label} timed out after ${timeoutMs} ms: no matching completed non-empty render frame`,
				)), timeoutMs);
				waiters.add(check);
				check();
			});
		},
	};
}
