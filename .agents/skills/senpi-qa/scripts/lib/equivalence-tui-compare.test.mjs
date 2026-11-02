// EQ.tui comparator: a release bump alone (the header's `senpi v<version>`) must not change the compare result, and
// every other difference, the header's own included, must still fail it (senpi#5180).
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTuiObservations, tuiVerdictLine } from "./equivalence-tui-compare.mjs";

const WIDTH = 100;
const PLAIN = "0/-1 0/-1 000000";
const ACCENT_BOLD = "33554432/5 0/-1 100000";
const DIM = "0/-1 0/-1 010000";

/** The header row as the TUI renders it: ` ` + bold accent `senpi` + dim ` v<version>`, padded to the width. */
function header(version, { name = "senpi", versionStyle = DIM } = {}) {
	const text = ` ${name} v${version}`;
	const end = text.length - 1;
	return {
		line: text.padEnd(WIDTH),
		styles: [`0-0 ${PLAIN}`, `1-${name.length} ${ACCENT_BOLD}`, `${name.length + 1}-${end} ${versionStyle}`, `${end + 1}-${WIDTH - 1} ${PLAIN}`],
	};
}

function observation(version, options = {}, body = " E01-DONE") {
	const top = header(version, options);
	const lines = ["", top.line, body.padEnd(WIDTH)];
	const styles = [[`0-${WIDTH - 1} ${PLAIN}`], top.styles, [`0-${WIDTH - 1} ${PLAIN}`]];
	return { O8: { tui: [{ label: "final", lines, styles }] } };
}

test("a version bump alone does not change the compare result", () => {
	for (const bumped of ["2026.10.31-1", "2026.10.19", "2026.11.30-12", "2027.1.2"]) {
		assert.deepEqual(diffTuiObservations(observation("2026.10.27-2"), observation(bumped)), [], bumped);
	}
});

test("every other header difference still fails the compare", () => {
	const golden = observation("2026.10.27-2");
	for (const actual of [
		observation("2026.10.27-2", { name: "senpx" }),
		observation("2026.10.31-1", { name: "pi" }),
		observation("2026.10.31-1", { versionStyle: PLAIN }),
		observation("2026.10.27-2-dirty"),
	]) {
		assert.notDeepEqual(diffTuiObservations(golden, actual), []);
	}
});

test("a version on any other row is compared as rendered", () => {
	const golden = observation("2026.10.27-2", {}, " senpi v2026.10.27-2 is out");
	const actual = observation("2026.10.27-2", {}, " senpi v2026.10.31-1 is out");
	assert.deepEqual(
		diffTuiObservations(golden, actual).map((row) => row.path),
		["$.O8.tui[0].lines[2]"],
	);
});

test("the EQ.tui verdict line appears only for a full pass", () => {
	const pass = (id) => ({ id, pass: true });
	assert.equal(
		tuiVerdictLine("darwin-arm64", [pass("E01"), pass("E04")], 0),
		"[PASS] EQ.tui golden-tui/darwin-arm64: 2/2 TUI captures equal their goldens",
	);
	for (const [results, stale] of [
		[[], 0],
		[[pass("E01"), { id: "E04", pass: false }], 0],
		[[pass("E01"), { id: "E04", pass: false, deferred: { owner: "x" } }], 0],
		[[pass("E01")], 1],
	]) {
		assert.equal(tuiVerdictLine("darwin-arm64", results, stale), undefined);
	}
});

test("a style change inside the header's version cells still fails the compare", () => {
	const golden = observation("2026.10.27-2");
	const actual = observation("2026.10.31-1");
	actual.O8.tui[0].styles[1] = [`0-0 ${PLAIN}`, `1-5 ${ACCENT_BOLD}`, `6-10 ${DIM}`, `11-19 ${PLAIN}`, `20-99 ${PLAIN}`];
	assert.notDeepEqual(diffTuiObservations(golden, actual), []);
});
