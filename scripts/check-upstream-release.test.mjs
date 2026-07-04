import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

describe("upstream release detector outputs", () => {
	it("preserves the release tag sha and emits upstream/main head separately on forced runs", () => {
		const stdout = execFileSync("node", ["scripts/check-upstream-release.mjs", "--force"], { encoding: "utf8" });
		const output = Object.fromEntries(
			stdout
				.trim()
				.split("\n")
				.map((line) => line.split("=", 2)),
		);
		const upstreamMain = execFileSync("git", ["rev-parse", "upstream/main"], { encoding: "utf8" }).trim();
		const releaseTag = output.tag;
		const releaseSha = execFileSync("git", ["rev-parse", `${releaseTag}^{commit}`], { encoding: "utf8" }).trim();

		assert.equal(output.proceed, "true");
		assert.equal(output.sha, releaseSha);
		assert.equal(output.upstream_head_sha, upstreamMain);
	});
});
