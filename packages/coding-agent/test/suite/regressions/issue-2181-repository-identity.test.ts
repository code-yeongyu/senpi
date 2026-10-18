import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareRepositoryIdentities,
	normalizeRemoteUrl,
	parseRepositoryIdentity,
	readRepositoryIdentity,
} from "../../../src/core/repository-identity.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-repo-identity-")));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

function repoWithCommit(content: string): string {
	const dir = tempDir();
	git(dir, "init", "-q");
	writeFileSync(join(dir, "README.md"), content);
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
	return dir;
}

describe("issue #2181 repository identity", () => {
	it("identifies a repository by its root commit, wherever it is checked out", async () => {
		const origin = repoWithCommit("one\n");
		const clone = join(tempDir(), "clone");
		git(tempDir(), "clone", "-q", origin, clone);
		const unrelated = repoWithCommit("two\n");

		const [originIdentity, cloneIdentity, unrelatedIdentity] = await Promise.all([
			readRepositoryIdentity(origin),
			readRepositoryIdentity(clone),
			readRepositoryIdentity(unrelated),
		]);

		expect(originIdentity?.rootCommits).toEqual([git(origin, "rev-parse", "HEAD").trim()]);
		expect(compareRepositoryIdentities(originIdentity, cloneIdentity)).toBe("same");
		expect(compareRepositoryIdentities(originIdentity, unrelatedIdentity)).toBe("different");
	});

	it("reports no identity outside a repository", async () => {
		expect(await readRepositoryIdentity(tempDir())).toBeUndefined();
	});

	it("falls back to the origin remote when a side has no commits", () => {
		const empty = { rootCommits: [], originUrl: "github.com/acme/app" };
		expect(
			compareRepositoryIdentities(empty, { rootCommits: ["a".repeat(40)], originUrl: "github.com/acme/app" }),
		).toBe("same");
		expect(compareRepositoryIdentities(empty, { rootCommits: [], originUrl: "github.com/acme/other" })).toBe(
			"different",
		);
		expect(compareRepositoryIdentities({ rootCommits: [] }, { rootCommits: ["a".repeat(40)] })).toBe("unknown");
		expect(compareRepositoryIdentities(undefined, empty)).toBe("unknown");
	});

	it("normalizes the spellings of one remote to the same key", () => {
		const spellings = [
			"git@github.com:Acme/App.git",
			"ssh://git@github.com:22/acme/app",
			"https://github.com/acme/app.git",
			"https://user@github.com/acme/app/",
		];
		expect(new Set(spellings.map(normalizeRemoteUrl))).toEqual(new Set(["github.com/acme/app"]));
	});

	it("reads a recorded identity back and rejects malformed records", () => {
		const root = "b".repeat(40);
		expect(parseRepositoryIdentity({ rootCommits: [root], originUrl: "github.com/acme/app" })).toEqual({
			rootCommits: [root],
			originUrl: "github.com/acme/app",
		});
		expect(parseRepositoryIdentity({ rootCommits: "nope" })).toBeUndefined();
		expect(parseRepositoryIdentity({ rootCommits: [] })).toBeUndefined();
		expect(parseRepositoryIdentity(null)).toBeUndefined();
	});
});
