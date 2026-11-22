const MAX_ROWS = 12;
const MAX_VALUE_LENGTH = 160;

function preview(value) {
	const text = JSON.stringify(value);
	if (text === undefined || text.length <= MAX_VALUE_LENGTH) return text;
	const omitted = text.length - MAX_VALUE_LENGTH;
	return `${text.slice(0, MAX_VALUE_LENGTH)}…(+${omitted} ${omitted === 1 ? "char" : "chars"})`;
}

export function summarizeDiffs(diffs) {
	const lines = diffs.slice(0, MAX_ROWS).map(
		(row) => `    ${row.path}: golden=${preview(row.golden)} actual=${preview(row.actual)}`,
	);
	const omitted = diffs.length - lines.length;
	if (omitted > 0) lines.push(`    …(+${omitted} more ${omitted === 1 ? "row" : "rows"})`);
	return lines;
}
