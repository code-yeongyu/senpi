import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadWebsearchConfig } from "../src/core/extensions/builtin/websearch/websearch/config.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function websearchJson(id: string, provider: string): string {
	return JSON.stringify({ auto: false, providers: [{ id, provider, apiKey: "test-key" }] });
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("vendored websearch config paths", () => {
	it("#given a project .senpi config #when loading #then reads <cwd>/.senpi/websearch.json", async () => {
		// given
		const cwd = await makeTempDir("websearch-cfg-senpi-");
		const home = await makeTempDir("websearch-cfg-home-");
		await mkdir(join(cwd, ".senpi"), { recursive: true });
		await writeFile(join(cwd, ".senpi", "websearch.json"), websearchJson("project-senpi", "exa"));

		// when
		const result = await loadWebsearchConfig({ cwd, homeDir: home });

		// then
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe(join(cwd, ".senpi", "websearch.json"));
			expect(result.config.providers[0]?.id).toBe("project-senpi");
		}
	});

	it("#given a project without .senpi but with .pi #when loading #then reads <cwd>/.pi/websearch.json", async () => {
		// given
		const cwd = await makeTempDir("websearch-cfg-pi-");
		const home = await makeTempDir("websearch-cfg-home-");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "websearch.json"), websearchJson("project-pi", "brave"));

		// when
		const result = await loadWebsearchConfig({ cwd, homeDir: home });

		// then
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe(join(cwd, ".pi", "websearch.json"));
			expect(result.config.providers[0]?.id).toBe("project-pi");
		}
	});

	it("#given a project .senpi config and a home .senpi config #when loading #then the project .senpi wins", async () => {
		// given
		const cwd = await makeTempDir("websearch-cfg-cwd-");
		const home = await makeTempDir("websearch-cfg-home-");
		await mkdir(join(cwd, ".senpi"), { recursive: true });
		await writeFile(join(cwd, ".senpi", "websearch.json"), websearchJson("project-senpi", "exa"));
		await mkdir(join(home, ".senpi"), { recursive: true });
		await writeFile(join(home, ".senpi", "websearch.json"), websearchJson("home-senpi", "tavily"));

		// when
		const result = await loadWebsearchConfig({ cwd, homeDir: home });

		// then
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toBe(join(cwd, ".senpi", "websearch.json"));
			expect(result.config.providers[0]?.id).toBe("project-senpi");
		}
	});
});
