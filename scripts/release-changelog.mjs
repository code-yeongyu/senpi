import { readFileSync, writeFileSync } from "node:fs";

export const CHANGELOGS = [
	"packages/ai/CHANGELOG.md",
	"packages/agent/CHANGELOG.md",
	"packages/coding-agent/CHANGELOG.md",
	"packages/senpi-codemode/CHANGELOG.md",
	"packages/orchestrator/CHANGELOG.md",
	"packages/tui/CHANGELOG.md",
	"packages/web-ui/CHANGELOG.md",
];

export const DEFAULT_UNRELEASED_SUBSECTIONS = [
	"### Breaking Changes",
	"### Added",
	"### Changed",
	"### Fixed",
	"### Removed",
];

export function extractUnreleasedSubsections(content) {
	const lines = content.split("\n");
	const start = lines.findIndex((line) => line.trim() === "## [Unreleased]");
	if (start === -1) {
		return null;
	}
	const subsections = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("## [")) {
			break;
		}
		if (line.startsWith("### ")) {
			subsections.push(line);
		}
	}
	return subsections;
}

export function resolveNextUnreleasedSubsections(capturedSubsections) {
	return capturedSubsections ?? DEFAULT_UNRELEASED_SUBSECTIONS;
}

export function buildUnreleasedBlock(subsections) {
	let block = "## [Unreleased]\n\n";
	for (const sub of subsections) {
		block += `${sub}\n\n`;
	}
	return block;
}

export function insertUnreleasedBlock(content, version, date, block) {
	if (extractUnreleasedSubsections(content) !== null) {
		return content;
	}
	const target = `## [${version}] - ${date}`;
	if (content.includes(target)) {
		return content.replace(target, () => `${block}${target}`);
	}
	const changelogTitle = "# Changelog\n\n";
	if (content.startsWith(changelogTitle)) {
		return `${changelogTitle}${block}${content.slice(changelogTitle.length)}`;
	}
	return `${block}${content}`;
}

export function stampChangelogs(version, date, dryRun, capturedSubsections, log, dryRunLog) {
	log(`stamping ${CHANGELOGS.length} CHANGELOG.md files: [Unreleased] -> [${version}] - ${date}`);
	for (const file of CHANGELOGS) {
		const content = readFileSync(file, "utf-8");
		const subsections = extractUnreleasedSubsections(content);
		if (subsections === null) {
			log(`  skip ${file}: no [Unreleased] section`);
			continue;
		}
		capturedSubsections.set(file, subsections);
		const updated = content.replace(/^## \[Unreleased\]$/m, `## [${version}] - ${date}`);
		const count = subsections.length;
		const noun = count === 1 ? "subsection header" : "subsection headers";
		if (dryRun) {
			dryRunLog(`write ${file} ([Unreleased] -> [${version}] - ${date}; ${count} ${noun} captured)`);
			continue;
		}
		writeFileSync(file, updated);
		log(`  stamped ${file} (${count} ${noun} captured)`);
	}
}

export function reAddUnreleasedSections(version, date, dryRun, capturedSubsections, log, dryRunLog) {
	log(`re-inserting [Unreleased] block in ${CHANGELOGS.length} CHANGELOG.md files`);
	for (const file of CHANGELOGS) {
		const subsections = resolveNextUnreleasedSubsections(capturedSubsections.get(file));
		const block = buildUnreleasedBlock(subsections);
		const count = subsections.length;
		const noun = count === 1 ? "placeholder" : "placeholders";
		if (dryRun) {
			dryRunLog(
				`insert [Unreleased] block in ${file} (${count} ${noun})`,
			);
			continue;
		}
		const content = readFileSync(file, "utf-8");
		const updated = insertUnreleasedBlock(content, version, date, block);
		if (updated === content) {
			log(`  skip ${file}: [Unreleased] already exists`);
			continue;
		}
		writeFileSync(file, updated);
		log(`  re-added [Unreleased] to ${file}`);
	}
}
