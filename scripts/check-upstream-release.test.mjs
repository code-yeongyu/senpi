import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

const CONTRIBUTOR_UPSTREAM_URL = "https://github.com/code-yeongyu/senpi.git";
const DETECTOR_UPSTREAM_URL = "https://github.com/badlogic/pi-mono.git";

let addedUpstreamRemote = false;
let originalUpstreamUrl = "";

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

function tryGitCommand(args) {
	try {
		execFileSync("git", args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("upstream release detector outputs", () => {
	let upstreamAvailable = false;

	before(() => {
		originalUpstreamUrl = tryGit(["remote", "get-url", "upstream"]);
		if (originalUpstreamUrl) {
			if (!tryGitCommand(["remote", "set-url", "upstream", CONTRIBUTOR_UPSTREAM_URL])) return;
		} else {
			if (!tryGitCommand(["remote", "add", "upstream", CONTRIBUTOR_UPSTREAM_URL])) return;
			addedUpstreamRemote = true;
		}
		// Probe the repository the detector actually reads. On credential-less/offline
		// runners (e.g. the release publish job checks out with
		// persist-credentials:false) this can be unreachable — skip rather than
		// hard-fail the whole `test:scripts` suite, since this test inherently
		// requires the external upstream repo.
		upstreamAvailable = Boolean(tryGit(["ls-remote", DETECTOR_UPSTREAM_URL, "refs/heads/main"]));
	});

	after(() => {
		if (addedUpstreamRemote) {
			git(["remote", "remove", "upstream"]);
		} else if (originalUpstreamUrl) {
			git(["remote", "set-url", "upstream", originalUpstreamUrl]);
		}
	});

	it("preserves the release tag sha and emits upstream/main head separately on forced runs", (t) => {
		if (!upstreamAvailable) {
			t.skip("upstream remote unreachable (offline or no git credentials)");
			return;
		}
		const stdout = execFileSync("node", ["scripts/check-upstream-release.mjs", "--force"], {
			encoding: "utf8",
			env: { ...process.env, GITHUB_OUTPUT: "" },
		});
		const output = Object.fromEntries(
			stdout
				.trim()
				.split("\n")
				.map((line) => line.split("=", 2)),
		);
		const upstreamMain = git(["ls-remote", DETECTOR_UPSTREAM_URL, "refs/heads/main"]).split(/\s+/, 1)[0];
		const releaseTag = output.tag;
		const remoteTagRefs = git([
			"ls-remote",
			"--tags",
			DETECTOR_UPSTREAM_URL,
			`refs/tags/${releaseTag}`,
			`refs/tags/${releaseTag}^{}`,
		]).split("\n");
		const peeledTag = remoteTagRefs.find((line) => line.endsWith(`refs/tags/${releaseTag}^{}`));
		const releaseSha = (peeledTag ?? remoteTagRefs[0]).split(/\s+/, 1)[0];

		assert.equal(output.proceed, "true");
		assert.equal(output.sha, releaseSha);
		assert.equal(output.upstream_head_sha, upstreamMain);
	});
});
