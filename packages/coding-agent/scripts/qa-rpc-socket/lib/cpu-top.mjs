/**
 * Hotspot ranking from a `.cpuprofile`: every function's INCLUSIVE sample count, read from the
 * `samples` array (one sampled leaf node per tick) walked up to the root. A function that appears
 * several times on one stack (recursion) counts once for that sample. `--cpu-prof-md` time columns
 * are never consulted.
 */

/** Native frames that carry an empty url are labelled with the builtin they are. */
const NATIVE_LABELS = new Map([["stringify", "JSON.stringify"]]);

function labelOf(callFrame) {
	const name = callFrame.functionName || "(anonymous)";
	if (!callFrame.url) return NATIVE_LABELS.get(name) ?? name;
	return name;
}

/** Rows `{ function, samples, share }` sorted by inclusive samples, share in percent of all samples. */
export function rankProfile(profile) {
	const samples = Array.isArray(profile?.samples) ? profile.samples : [];
	if (samples.length === 0) throw new Error("cpu profile has no samples");
	const nodes = new Map();
	const parentOf = new Map();
	for (const node of profile.nodes) {
		nodes.set(node.id, node);
		for (const child of node.children ?? []) parentOf.set(child, node.id);
	}
	const perLeaf = new Map();
	for (const id of samples) perLeaf.set(id, (perLeaf.get(id) ?? 0) + 1);
	const inclusive = new Map();
	for (const [leaf, count] of perLeaf) {
		const seen = new Set();
		for (let id = leaf; id !== undefined; id = parentOf.get(id)) {
			const node = nodes.get(id);
			if (node === undefined) break;
			const label = labelOf(node.callFrame);
			if (seen.has(label)) continue;
			seen.add(label);
			inclusive.set(label, (inclusive.get(label) ?? 0) + count);
		}
	}
	const total = samples.length;
	return [...inclusive]
		.filter(([label]) => label !== "(root)")
		.map(([label, count]) => ({ function: label, samples: count, share: (100 * count) / total }))
		.sort((a, b) => b.samples - a.samples || a.function.localeCompare(b.function));
}

export function shareOf(rows, name) {
	return rows.find((row) => row.function === name)?.share ?? 0;
}

export function renderCpuTop(rows, { limit = 50, totalSamples, title = "server" } = {}) {
	const lines = [
		`# cpu-top (${title})`,
		"",
		`Ranked by inclusive samples from the .cpuprofile \`samples\` array (${totalSamples ?? "?"} samples).`,
		"",
		"| # | function | inclusive samples | share |",
		"|---|---|---|---|",
	];
	rows.slice(0, limit).forEach((row, index) => {
		lines.push(`| ${index + 1} | ${row.function} | ${row.samples} | ${row.share.toFixed(2)}% |`);
	});
	return `${lines.join("\n")}\n`;
}
