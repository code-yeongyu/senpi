// Summarizes a regenerated OpenGateway catalog against the committed one for the
// scheduled refresh workflow (.github/workflows/opengateway-catalog-refresh.yml):
// a Markdown PR body, a CHANGELOG [Unreleased] entry, and `changed=true|false`
// on stdout for $GITHUB_OUTPUT.
//
//   tsx scripts/opengateway-catalog-diff.ts --base <old.json> --head <new.json> \
//     [--markdown <out.md>] [--changelog <CHANGELOG.md>]

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

interface CatalogRow {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, unknown>;
	[field: string]: unknown;
}

export interface OpenGatewayCatalogDiff {
	added: CatalogRow[];
	removed: string[];
	changed: { id: string; changes: string[] }[];
}


function rows(grouped: Record<string, Record<string, CatalogRow>>): Map<string, CatalogRow> {
	return new Map(
		Object.values(grouped)
			.flatMap((entries) => Object.values(entries))
			.map((row) => [row.id, row]),
	);
}

function show(value: unknown): string {
	return value === undefined ? "unset" : JSON.stringify(value);
}

export function diffOpenGatewayCatalogs(
	base: Record<string, Record<string, CatalogRow>>,
	head: Record<string, Record<string, CatalogRow>>,
): OpenGatewayCatalogDiff {
	const before = rows(base);
	const after = rows(head);
	const changed: OpenGatewayCatalogDiff["changed"] = [];
	for (const [id, row] of after) {
		const previous = before.get(id);
		if (!previous) continue;
		const fields = [...new Set([...Object.keys(previous), ...Object.keys(row)])].sort() as (keyof CatalogRow)[];
		const changes = fields
			.filter((field) => show(previous[field]) !== show(row[field]))
			.map((field) => `${field}: ${show(previous[field])} -> ${show(row[field])}`);
		if (changes.length > 0) changed.push({ id, changes });
	}
	return {
		added: [...after.values()].filter((row) => !before.has(row.id)),
		removed: [...before.keys()].filter((id) => !after.has(id)),
		changed,
	};
}

export function hasCatalogChanges(diff: OpenGatewayCatalogDiff): boolean {
	return diff.added.length + diff.removed.length + diff.changed.length > 0;
}

export function renderCatalogDiffMarkdown(diff: OpenGatewayCatalogDiff): string {
	const lines = ["## OpenGateway catalog changes", ""];
	if (diff.added.length > 0) {
		lines.push("### Added", "");
		for (const row of diff.added) {
			lines.push(`- \`${row.id}\` (${row.name}): context ${row.contextWindow}, max output ${row.maxTokens}, cost ${show(row.cost)}`);
		}
		lines.push("");
	}
	if (diff.removed.length > 0) {
		lines.push("### Removed", "", ...diff.removed.map((id) => `- \`${id}\``), "");
	}
	if (diff.changed.length > 0) {
		lines.push("### Changed", "");
		for (const { id, changes } of diff.changed) lines.push(`- \`${id}\`: ${changes.join("; ")}`);
		lines.push("");
	}
	if (!hasCatalogChanges(diff)) lines.push("No model changes.", "");
	return lines.join("\n");
}

export function catalogChangelogEntry(diff: OpenGatewayCatalogDiff): string {
	const parts: string[] = [];
	if (diff.added.length > 0) parts.push(`adds ${diff.added.map((row) => `\`${row.id}\``).join(", ")}`);
	if (diff.removed.length > 0) parts.push(`removes ${diff.removed.map((id) => `\`${id}\``).join(", ")}`);
	if (diff.changed.length > 0) parts.push(`updates limits, prices, or capabilities for ${diff.changed.length} models`);
	return `- The OpenGateway model catalog now matches the gateway: it ${parts.join("; ")}.`;
}

export function insertUnreleasedChangedEntry(changelog: string, entry: string): string {
	const unreleased = changelog.indexOf("## [Unreleased]");
	const nextRelease = changelog.indexOf("\n## [", unreleased + 1);
	const changedHeading = changelog.indexOf("### Changed\n", unreleased);
	if (unreleased < 0 || changedHeading < 0 || (nextRelease >= 0 && changedHeading > nextRelease)) {
		throw new Error("CHANGELOG.md has no ### Changed section under ## [Unreleased]");
	}
	const insertAt = changedHeading + "### Changed\n\n".length;
	const sectionHasEntries = changelog.startsWith("- ", insertAt);
	return `${changelog.slice(0, insertAt)}${entry}\n${sectionHasEntries ? "" : "\n"}${changelog.slice(insertAt)}`;
}

function readOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function main(args: string[]): void {
	const basePath = readOption(args, "--base");
	const headPath = readOption(args, "--head");
	if (!basePath || !headPath) throw new Error("usage: opengateway-catalog-diff --base <old.json> --head <new.json>");
	const diff = diffOpenGatewayCatalogs(
		JSON.parse(readFileSync(basePath, "utf8")),
		JSON.parse(readFileSync(headPath, "utf8")),
	);
	const markdownPath = readOption(args, "--markdown");
	if (markdownPath) writeFileSync(markdownPath, renderCatalogDiffMarkdown(diff));
	const changelogPath = readOption(args, "--changelog");
	if (changelogPath && hasCatalogChanges(diff)) {
		writeFileSync(
			changelogPath,
			insertUnreleasedChangedEntry(readFileSync(changelogPath, "utf8"), catalogChangelogEntry(diff)),
		);
	}
	console.log(`changed=${hasCatalogChanges(diff)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
