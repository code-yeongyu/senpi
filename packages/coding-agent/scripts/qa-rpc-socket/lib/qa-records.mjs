/**
 * Scenario evidence (`<out>/<scenario>.jsonl`, appended synchronously so a hang still leaves every
 * earlier record) and the event-gated record wait: subscribe first, then resolve on the first matching
 * record, or fail with `record_timeout` at the bounded deadline.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { QaFailure } from "./qa-failure.mjs";

export function createScenarioLog(path) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
	return {
		path,
		write(record) {
			appendFileSync(path, `${JSON.stringify(record)}\n`);
		},
		readAll() {
			return readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
	};
}

export function awaitRecord(subscribe, predicate, { name, deadlineMs }) {
	return new Promise((resolve, reject) => {
		let unsubscribe = () => undefined;
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new QaFailure("record_timeout", `no ${name} record within ${deadlineMs}ms`));
		}, deadlineMs);
		unsubscribe = subscribe((record) => {
			if (!predicate(record)) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(record);
		});
	});
}
