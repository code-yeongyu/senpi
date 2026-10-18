#!/usr/bin/env node
/**
 * JSONL assertion log + strict declared-defect policy for the ask-user probe.
 *
 * Every asserted criterion is one JSON record. A scenario may DECLARE a defect
 * (id + expected behavior + production reference) up front; the run then must
 * OBSERVE it exactly. A declared defect that no longer reproduces is reported
 * as `defect-fixed` and FAILS the run, so declarations cannot silently rot.
 */

import { writeFileSync } from "node:fs";

export function createReport(scenario, { out } = {}) {
	const records = [];
	const declared = new Map();
	const observed = new Map();
	let failed = false;
	let errored = false;
	const emit = (kind, name, data) => {
		const record = { ts: new Date().toISOString(), scenario, kind, name, ...data };
		records.push(record);
		process.stdout.write(`${JSON.stringify(record)}\n`);
		return record;
	};
	return {
		info(name, data = {}) {
			emit("info", name, data);
		},
		pass(name, data = {}) {
			emit("pass", name, data);
		},
		fail(name, data = {}) {
			failed = true;
			if (name === "scenario-error") errored = true;
			emit("fail", name, data);
		},
		observe(direction, label, line) {
			const trimmed = String(line).slice(0, 400);
			records.push({ ts: new Date().toISOString(), scenario, kind: "frame", label, direction, line });
			if (label === "host" || label === "host1" || label === "host2") process.stdout.write(`${JSON.stringify({ scenario, kind: "frame", label, direction, line: trimmed })}\n`);
		},
		declareDefect(defect) {
			declared.set(defect.id, { soft: false, ...defect });
			emit("defect-declared", defect.id, { soft: false, ...defect });
		},
		observeDefect(id, actual) {
			observed.set(id, actual);
			emit("defect-observed", id, { ...declared.get(id), actual });
		},
		/** Assert `predicate(actual)`; on mismatch either fail or record a declared defect. */
		check(name, { expected, actual, defect }) {
			const matches = JSON.stringify(actual) === JSON.stringify(expected);
			if (matches) {
				this.pass(name, { expected, actual });
				return true;
			}
			if (defect) {
				this.observeDefect(defect.id, actual);
				return false;
			}
			this.fail(name, { expected, actual });
			return false;
		},
		finish() {
			for (const [id, defect] of declared) {
				if (observed.has(id)) continue;
				if (defect.soft) {
					emit("defect-not-observed", id, { ...defect, note: "soft defect not reproduced in this run (timer race)" });
					continue;
				}
				if (errored) {
					emit("defect-unresolved", id, { ...defect, note: "scenario errored before the defect could be observed" });
					continue;
				}
				failed = true;
				emit("defect-fixed", id, { ...defect, note: "declared defect no longer reproduces; remove the declaration" });
			}
			for (const id of observed.keys()) {
				if (declared.has(id)) continue;
				failed = true;
				emit("defect-undeclared", id, { note: "observed a defect that was not declared" });
			}
			const summary = { scenario, pass: records.filter((r) => r.kind === "pass").length, fail: records.filter((r) => r.kind === "fail").length, defects: [...observed.keys()] };
			if (out) writeFileSync(out, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
			emit("summary", "summary", summary);
			return { ok: !failed, summary, records };
		},
	};
}
