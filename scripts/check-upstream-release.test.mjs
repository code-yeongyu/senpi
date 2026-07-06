import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

const UPSTREAM_REMOTE_URL = "https://github.com/badlogic/pi-mono.git";

let addedUpstreamRemote = false;

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(args) {
	try {
		return git(args);
	} catch {
		return "";
	}
}

describe("upstream release detector outputs", () => {
	before(() => {
		if (!tryGit(["remote", "get-url", "upstream"])) {
			git(["remote", "add", "upstream", UPSTREAM_REMOTE_URL]);
			addedUpstreamRemote = true;
		}
		git(["fetch", "--quiet", "upstream", "+refs/heads/main:refs/remotes/upstream/main"]);
	});

	after(() => {
		if (addedUpstreamRemote) {
			git(["remote", "remove", "upstream"]);
		}
	});

	it("preserves the release tag sha and emits upstream/main head separately on forced runs", () => {
		const stdout = execFileSync("node", ["scripts/check-upstream-release.mjs", "--force"], { encoding: "utf8" });
		const output = Object.fromEntries(
			stdout
				.trim()
				.split("\n")
				.map((line) => line.split("=", 2)),
		);
		const upstreamMain = git(["rev-parse", "upstream/main"]);
		const releaseTag = output.tag;
		const releaseSha = tryGit(["rev-parse", `refs/upstream-tags/${releaseTag}^{commit}`]) || git(["rev-parse", `${releaseTag}^{commit}`]);

		assert.equal(output.proceed, "true");
		assert.equal(output.sha, releaseSha);
		assert.equal(output.upstream_head_sha, upstreamMain);
	});
});
