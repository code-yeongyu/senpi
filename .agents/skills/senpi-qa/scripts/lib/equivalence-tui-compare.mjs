// EQ.tui comparator (plan P0-05c): the diff `--compare --surface tui` applies between a golden and an observed capture.
//
// The one value it masks is the release version in the TUI header row (` senpi v2026.10.31-1`, interactive-mode.ts
// builtInHeader via version-label.ts formatDisplayVersion): every release changes it, so a golden that pins it fails on
// the next release (senpi#5180). Both sides of the compare get the same rewrite - the version becomes `<version>` and
// the row's style runs are re-derived as if `<version>` had been rendered in the version's own style - so the row keeps
// its width and every other cell, the version's style included, is still compared as rendered. A version anywhere else,
// a header with anything after the version, or version cells that do not share one style are compared as captured.
// Goldens are recorded unmasked; only the comparison sees the token.
import { diffNormalized } from "./equivalence-normalize.mjs";

/** The whole header row: ` senpi ` + `v<digits>(.<digits>)+[-<n>]` + padding, nothing else. */
const HEADER_VERSION = /^( senpi )(v\d+(?:\.\d+)+(?:-\d+)?)(?= *$)/;
const VERSION_TOKEN = "<version>";
const STYLE_RUN = /^(\d+)-(\d+) (.+)$/;

/** Per-column style keys of a row's runs (`<from>-<to> <key>`), or undefined when a run has another shape. */
function styleColumns(runs) {
	const columns = [];
	for (const run of runs) {
		const match = STYLE_RUN.exec(run);
		if (!match) return undefined;
		for (let col = Number(match[1]); col <= Number(match[2]); col++) columns[col] = match[3];
	}
	return columns;
}

function styleRuns(columns) {
	const runs = [];
	let from = 0;
	for (let col = 1; col <= columns.length; col++) {
		if (col < columns.length && columns[col] === columns[from]) continue;
		runs.push(`${from}-${col - 1} ${columns[from]}`);
		from = col;
	}
	return runs;
}

function maskHeaderVersion(checkpoint) {
	const lines = [...checkpoint.lines];
	const styles = [...checkpoint.styles];
	lines.forEach((line, row) => {
		const match = HEADER_VERSION.exec(line);
		const columns = match && Array.isArray(styles[row]) ? styleColumns(styles[row]) : undefined;
		if (!columns) return;
		const [, prefix, version] = match;
		const versionStyles = new Set(columns.slice(prefix.length, prefix.length + version.length));
		if (versionStyles.size !== 1) return;
		const [versionStyle] = versionStyles;
		const masked = [
			...columns.slice(0, prefix.length),
			...Array(VERSION_TOKEN.length).fill(versionStyle),
			...columns.slice(prefix.length + version.length),
		];
		// Only padding follows the version, so the row is cut or padded back to its rendered width with its last cell.
		while (masked.length < columns.length) masked.push(columns.at(-1));
		masked.length = columns.length;
		lines[row] = `${prefix}${VERSION_TOKEN}`.padEnd(line.length);
		styles[row] = styleRuns(masked);
	});
	return { ...checkpoint, lines, styles };
}

const maskObservation = (observation) =>
	observation?.O8?.tui
		? { ...observation, O8: { ...observation.O8, tui: observation.O8.tui.map(maskHeaderVersion) } }
		: observation;

/** Diff rows between two TUI observations (`{ O8: { tui: [checkpoint] } }`), empty when equal. */
export function diffTuiObservations(golden, actual) {
	return diffNormalized(maskObservation(golden), maskObservation(actual));
}
