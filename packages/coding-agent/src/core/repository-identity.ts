import { execFile } from "node:child_process";

export const REPOSITORY_IDENTITY_ENTRY_TYPE = "repository-identity";

const GIT_TIMEOUT_MS = 5_000;
const COMMIT_HASH = /^[0-9a-f]{40,64}$/;
// An inherited repository location would make every directory report that one repository.
const GIT_LOCATION_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]);

export interface RepositoryIdentity {
	readonly rootCommits: readonly string[];
	readonly originUrl?: string;
}

export type RepositoryMatch = "same" | "different" | "unknown";

export type GitRunner = (dir: string, args: readonly string[]) => Promise<string | undefined>;

const runGit: GitRunner = (dir, args) =>
	new Promise((resolve) => {
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_LOCATION_ENV.has(name)));
		execFile("git", ["-C", dir, ...args], { env, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			resolve(error ? undefined : stdout);
		});
	});

export async function readRepositoryIdentity(
	dir: string,
	run: GitRunner = runGit,
): Promise<RepositoryIdentity | undefined> {
	const [roots, origin] = await Promise.all([
		run(dir, ["rev-list", "--max-parents=0", "HEAD"]),
		run(dir, ["config", "--get", "remote.origin.url"]),
	]);
	const rootCommits = (roots ?? "")
		.split(/\s+/)
		.filter((line) => COMMIT_HASH.test(line))
		.sort();
	const originUrl = origin?.trim() ? normalizeRemoteUrl(origin) : undefined;
	if (rootCommits.length === 0 && originUrl === undefined) return undefined;
	return originUrl === undefined ? { rootCommits } : { rootCommits, originUrl };
}

/** `git@host:owner/repo.git`, `ssh://git@host:22/owner/repo`, and `https://host/owner/repo` all become `host/owner/repo`. */
export function normalizeRemoteUrl(url: string): string {
	const trimmed = url.trim();
	const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
	const withoutScheme = scpLike
		? `${scpLike[1]}/${scpLike[2]}`
		: trimmed
				.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
				.replace(/^[^@/]+@/, "")
				.replace(/^([^/:]+):\d+\//, "$1/");
	return withoutScheme
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.toLowerCase();
}

/**
 * Two checkouts are the same repository when their histories share a root commit. Without commits on
 * either side the origin remote decides. Anything less is "unknown", never a guess.
 */
export function compareRepositoryIdentities(
	a: RepositoryIdentity | undefined,
	b: RepositoryIdentity | undefined,
): RepositoryMatch {
	if (a === undefined || b === undefined) return "unknown";
	if (a.rootCommits.length > 0 && b.rootCommits.length > 0) {
		return a.rootCommits.some((commit) => b.rootCommits.includes(commit)) ? "same" : "different";
	}
	if (a.originUrl !== undefined && b.originUrl !== undefined) {
		return a.originUrl === b.originUrl ? "same" : "different";
	}
	return "unknown";
}

export function parseRepositoryIdentity(value: unknown): RepositoryIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { rootCommits, originUrl } = value as { rootCommits?: unknown; originUrl?: unknown };
	if (!Array.isArray(rootCommits) || !rootCommits.every((commit) => typeof commit === "string")) return undefined;
	if (originUrl !== undefined && typeof originUrl !== "string") return undefined;
	const commits = rootCommits.filter((commit) => COMMIT_HASH.test(commit)).sort();
	if (commits.length === 0 && originUrl === undefined) return undefined;
	return originUrl === undefined ? { rootCommits: commits } : { rootCommits: commits, originUrl };
}

export function sameRepositoryIdentity(a: RepositoryIdentity | undefined, b: RepositoryIdentity | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.originUrl === b.originUrl && a.rootCommits.join(",") === b.rootCommits.join(",");
}
