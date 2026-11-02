const sectionsOf = (text) => {
	const lines = text.split("\n");
	const starts = lines.flatMap((line, index) => (line.startsWith("## [") ? [index] : []));
	const preamble = lines.slice(0, starts[0] ?? lines.length).join("\n");
	const sections = starts.map((start, i) => {
		const body = lines.slice(start, starts[i + 1] ?? lines.length).join("\n");
		return { name: /^## \[([^\]]+)\]/.exec(lines[start])?.[1] ?? "", text: i + 1 < starts.length ? `${body}\n` : body };
	});
	return { preamble: starts.length ? `${preamble}\n` : preamble, sections };
};

const isEntry = (line) => line.trim() !== "" && !line.startsWith("#");

/**
 * main's changelog after a pinned release merges back (senpi#3731 review): [Unreleased] keeps only what main added
 * after the pinned commit, the version's section is the tag's own, and older sections are main's. Returns null when a
 * piece is missing, so the caller keeps the merged file.
 */
export function changelogAfterPinnedRelease({ main, pinned, released, version }) {
	const ofMain = sectionsOf(main);
	const unreleasedIndex = ofMain.sections.findIndex((s) => s.name === "Unreleased");
	const release = sectionsOf(released).sections.find((s) => s.name === version);
	if (unreleasedIndex === -1 || release === undefined) return null;
	const shipped = new Map();
	const pinnedUnreleased = sectionsOf(pinned).sections.find((s) => s.name === "Unreleased");
	for (const line of pinnedUnreleased?.text.split("\n") ?? []) {
		if (isEntry(line)) shipped.set(line, (shipped.get(line) ?? 0) + 1);
	}
	const later = ofMain.sections[unreleasedIndex].text
		.split("\n")
		.filter((line) => {
			const left = shipped.get(line) ?? 0;
			if (!isEntry(line) || left === 0) return true;
			shipped.set(line, left - 1);
			return false;
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
	const older = ofMain.sections.slice(unreleasedIndex + 1).filter((s) => s.name !== version);
	return [ofMain.preamble, later, release.text, ...older.map((s) => s.text)].join("");
}
