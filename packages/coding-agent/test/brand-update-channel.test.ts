import { afterEach, describe, expect, test } from "vitest";
import { BRAND_ENV_VAR, parseBrandProfile, resetBrandProfileForTests } from "../src/core/brand.ts";
import { getReleaseChangelogUrl, readAvailableVersion } from "../src/utils/version-check.ts";

const CHANNEL = {
	name: "omo",
	displayVersion: "5.0.0-0.beta.4",
	configDir: ".omo",
	flatLayout: true,
	envPrefix: "OMO",
	userAgent: "omo",
	originator: "omo",
	update: {
		packageName: "omo-ai",
		distTag: "beta",
		command: "npm i -g omo-ai@beta",
		changelogUrl: "https://github.com/code-yeongyu/oh-my-openagent/releases/tag/v{version}",
	},
};

describe("brand update channel", () => {
	afterEach(() => {
		delete process.env[BRAND_ENV_VAR];
		resetBrandProfileForTests();
	});

	test("parses the channel and defaults the dist-tag to latest", () => {
		expect(parseBrandProfile(JSON.stringify(CHANNEL))?.update).toEqual(CHANNEL.update);
		expect(parseBrandProfile('{"name":"omo","update":{"packageName":"omo-ai","command":"x"}}')?.update).toEqual({
			packageName: "omo-ai",
			distTag: "latest",
			command: "x",
			changelogUrl: undefined,
		});
	});

	test("ignores a channel that cannot be acted on", () => {
		expect(parseBrandProfile('{"name":"omo","update":{"packageName":"omo-ai"}}')?.update).toBeUndefined();
		expect(parseBrandProfile('{"name":"omo","update":"beta"}')?.update).toBeUndefined();
	});

	test("reads the branded version from a dist-tags document, not from `version`", () => {
		const distTags = { latest: "0.0.0-beta.0", beta: "5.0.0-0.beta.4" };

		expect(readAvailableVersion(distTags, CHANNEL.update)).toBe("5.0.0-0.beta.4");
		expect(readAvailableVersion(distTags, { ...CHANNEL.update, distTag: "missing" })).toBeUndefined();
	});

	test("reads the engine version from the registry document when unbranded", () => {
		expect(readAvailableVersion({ version: "2026.8.10" }, undefined)).toBe("2026.8.10");
		expect(readAvailableVersion({}, undefined)).toBeUndefined();
	});

	test("points the changelog at the branded release notes", () => {
		process.env[BRAND_ENV_VAR] = JSON.stringify(CHANNEL);
		resetBrandProfileForTests();

		expect(getReleaseChangelogUrl("5.0.0-0.beta.4")).toBe(
			"https://github.com/code-yeongyu/oh-my-openagent/releases/tag/v5.0.0-0.beta.4",
		);
	});

	test("keeps the engine changelog for a standalone install", () => {
		resetBrandProfileForTests();

		expect(getReleaseChangelogUrl("2026.8.10")).toBe(
			"https://github.com/code-yeongyu/senpi/blob/v2026.8.10/packages/coding-agent/CHANGELOG.md",
		);
	});
});
