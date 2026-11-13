import { afterEach, describe, expect, test, vi } from "vitest";
import { resetBrandProfileForTests } from "../src/core/brand.ts";
import { checkForNewPiVersion, readLatestReleaseVersion } from "../src/utils/version-check.ts";

const NPM_LATEST_URL = "https://registry.npmjs.org/%40code-yeongyu%2Fsenpi/latest";
const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/code-yeongyu/senpi/releases/latest";

function stubUpdateSources(npmVersion: string, releaseTag: string): string[] {
	// vitest.config.ts sets PI_OFFLINE for the whole suite; these tests answer every request from the stub.
	vi.stubEnv("PI_OFFLINE", undefined);
	vi.stubEnv("SENPI_OFFLINE", undefined);
	const asked: string[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		asked.push(url);
		if (url === NPM_LATEST_URL) return Response.json({ version: npmVersion });
		if (url === GITHUB_LATEST_RELEASE_URL)
			return Response.json({ tag_name: releaseTag, draft: false, prerelease: false });
		return new Response("not found", { status: 404 });
	});
	return asked;
}

describe("binary install update channel (senpi#6633)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		resetBrandProfileForTests();
	});

	test("npm newer + GitHub Release older: no notice for a binary install", async () => {
		const asked = stubUpdateSources("2026.11.14-1", "v2026.11.13-1");

		expect(await checkForNewPiVersion("2026.11.13-1", { installMethod: "bun-binary" })).toBeUndefined();
		expect(asked).toEqual([GITHUB_LATEST_RELEASE_URL]);
	});

	test("the same pair still notifies an npm install", async () => {
		const asked = stubUpdateSources("2026.11.14-1", "v2026.11.13-1");

		expect((await checkForNewPiVersion("2026.11.13-1", { installMethod: "npm" }))?.version).toBe("2026.11.14-1");
		expect(asked).toEqual([NPM_LATEST_URL]);
	});

	test("a binary install is notified once the GitHub Release is published", async () => {
		stubUpdateSources("2026.11.14-1", "v2026.11.14-1");

		expect((await checkForNewPiVersion("2026.11.13-1", { installMethod: "bun-binary" }))?.version).toBe(
			"2026.11.14-1",
		);
	});

	test("reads the version from the release tag and refuses drafts, prereleases and malformed payloads", () => {
		expect(readLatestReleaseVersion({ tag_name: "v2026.11.13-1" })).toBe("2026.11.13-1");
		expect(readLatestReleaseVersion({ tag_name: "2026.11.13" })).toBe("2026.11.13");
		expect(readLatestReleaseVersion({ tag_name: "v2026.11.13-1", draft: true })).toBeUndefined();
		expect(readLatestReleaseVersion({ tag_name: "v2026.11.13-1", prerelease: true })).toBeUndefined();
		expect(readLatestReleaseVersion({ tag_name: "" })).toBeUndefined();
		expect(readLatestReleaseVersion({})).toBeUndefined();
		expect(readLatestReleaseVersion(null)).toBeUndefined();
	});
});
