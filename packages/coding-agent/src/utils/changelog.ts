import path from "node:path";
import { existsSync, readFileSync } from "fs";
import { compare, valid } from "semver";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	suffix?: string;
	version?: string;
	content: string;
}

const GITHUB_REPO = "earendil-works/pi";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

function entryVersion(entry: ChangelogEntry): string {
	return entry.version ?? `${entry.major}.${entry.minor}.${entry.patch}${entry.suffix ? `-${entry.suffix}` : ""}`;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CALVER_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-([2-9]\d*))?$/;

function isValidDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isForeignVersion(version: string): boolean {
	return version.startsWith("0.0.0-omob.") || /^\d+\.\d+\.\d+-0\.beta\./.test(version);
}

function compareVersionStrings(left: string, right: string): number | undefined {
	const leftCalver = CALVER_RE.exec(left);
	const rightCalver = CALVER_RE.exec(right);
	if (leftCalver && rightCalver) {
		const leftParts = [
			Number(leftCalver[1]),
			Number(leftCalver[2]),
			Number(leftCalver[3]),
			Number(leftCalver[4] ?? 1),
		];
		const rightParts = [
			Number(rightCalver[1]),
			Number(rightCalver[2]),
			Number(rightCalver[3]),
			Number(rightCalver[4] ?? 1),
		];
		for (let index = 0; index < leftParts.length; index += 1) {
			if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
		}
		return 0;
	}
	const leftValid = valid(left);
	const rightValid = valid(right);
	if (!leftValid || !rightValid || isForeignVersion(left) !== isForeignVersion(right)) return undefined;
	return Math.sign(compare(leftValid, rightValid));
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number; suffix?: string; version: string } | null =
			null;
		let fence: { character: "`" | "~"; length: number } | null = null;

		for (const line of lines) {
			const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (fenceMatch) {
				const character = fenceMatch[1][0] === "`" ? "`" : "~";
				if (!fence) fence = { character, length: fenceMatch[1].length };
				else if (fence.character === character && fenceMatch[1].length >= fence.length) fence = null;
			}
			const headerMatch =
				fence === null
					? /^##[ \t]+(?:\[([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\]|([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)))(?:[ \t]+-[ \t]+(\d{4}-\d{2}-\d{2}))?[ \t]*$/.exec(
							line,
						)
					: null;
			if (
				headerMatch ||
				(fence === null && /^##[ \t]+\[?Unreleased\]?[ \t]*(?:-[ \t]+\d{4}-\d{2}-\d{2})?[ \t]*$/.test(line))
			) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line
				if (headerMatch && isValidDate(headerMatch[3] ?? "2026-01-01")) {
					const parts = /^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/.exec(headerMatch[1] ?? headerMatch[2]);
					if (!parts) {
						currentVersion = null;
						currentLines = [];
						continue;
					}
					currentVersion = {
						major: Number(parts[1]),
						minor: Number(parts[2]),
						patch: Number(parts[3]),
						suffix: parts[4],
						version: `${parts[1]}.${parts[2]}.${parts[3]}${parts[4] ? `-${parts[4]}` : ""}`,
					};
					currentLines = [];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	return compareVersionStrings(entryVersion(v1), entryVersion(v2)) ?? 0;
}

/**
 * Get entries newer than lastVersion
 */
export function getNewEntries(
	entries: ChangelogEntry[],
	lastVersion: string,
	currentVersion?: string,
): ChangelogEntry[] {
	// Parse lastVersion
	const parts = lastVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/);
	if (!parts || isForeignVersion(lastVersion)) return [];
	const current = currentVersion && VERSION_RE.test(currentVersion) ? currentVersion : undefined;
	if (current && (isForeignVersion(current) || compareVersionStrings(lastVersion, current) === undefined)) return [];
	return entries.filter((entry, index, all) => {
		const version = entryVersion(entry);
		const lower = compareVersionStrings(version, lastVersion);
		const upper = current ? compareVersionStrings(version, current) : 0;
		return (
			lower !== undefined &&
			lower > 0 &&
			(upper === undefined || upper <= 0) &&
			all.findIndex((candidate) => entryVersion(candidate) === version) === index
		);
	});
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config.ts";
