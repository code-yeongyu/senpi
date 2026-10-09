import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../../../src/core/model-config.ts";

const dirs: string[] = [];
function modelsJsonFile(content: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "senpi-2044-"));
	dirs.push(dir);
	const path = join(dir, "models.json");
	writeFileSync(path, content);
	return { dir, path };
}
const backups = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("models.json.backup-"));
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LEGACY_JSONC = `{
  // overlay kept from before the rename
  "providers": {
    "openai-codex": {
      "modelOverrides": { "gpt-6-astra": { "contextWindow": 922000 } }
    },
    "anthropic": { "baseUrl": "https://api-key-lane", "models": [] },
  },
  "disabledProviders": ["claude-sdk-oauth"]
}
`;

describe("models.json legacy provider ids are migrated on disk (senpi#2044)", () => {
	it("rewrites only the legacy tokens, keeps comments and formatting, backs up the original, and warns about nothing", () => {
		const { dir, path } = modelsJsonFile(LEGACY_JSONC);
		const config = ModelConfig.loadSync(path);

		expect(readFileSync(path, "utf8")).toBe(
			LEGACY_JSONC.replace('"openai-codex"', '"chatgpt-subscription"').replace(
				'"claude-sdk-oauth"',
				'"anthropic-subscription"',
			),
		);
		expect(backups(dir)).toHaveLength(1);
		expect(readFileSync(join(dir, backups(dir)[0] ?? ""), "utf8")).toBe(LEGACY_JSONC);
		expect(config.getWarnings()).toEqual([]);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("chatgpt-subscription")?.modelOverrides).toMatchObject({
			"gpt-6-astra": { contextWindow: 922000 },
		});
		expect(config.isProviderDisabled("anthropic-subscription")).toBe(true);
	});

	it("migrates through the async load path too", async () => {
		const { path } = modelsJsonFile(LEGACY_JSONC);
		const config = await ModelConfig.load(path);
		expect(readFileSync(path, "utf8")).not.toContain("openai-codex");
		expect(config.getWarnings()).toEqual([]);
	});

	it("drops a legacy entry shadowed by its canonical entry, wherever it sits", () => {
		const legacyLast = `{
  "providers": {
    "chatgpt-subscription": { "baseUrl": "https://canonical", "models": [] },
    "openai-codex": { "baseUrl": "https://legacy", "models": [] }
  }
}
`;
		const legacyFirst = `{
  "providers": {
    "claude-sdk-oauth": { "baseUrl": "https://legacy", "models": [] },
    "anthropic-subscription": { "baseUrl": "https://canonical", "models": [] }
  }
}
`;
		const last = modelsJsonFile(legacyLast);
		expect(ModelConfig.loadSync(last.path).getProvider("chatgpt-subscription")).toMatchObject({
			baseUrl: "https://canonical",
		});
		expect(readFileSync(last.path, "utf8")).toBe(`{
  "providers": {
    "chatgpt-subscription": { "baseUrl": "https://canonical", "models": [] }
  }
}
`);
		const first = modelsJsonFile(legacyFirst);
		expect(ModelConfig.loadSync(first.path).getProvider("anthropic-subscription")).toMatchObject({
			baseUrl: "https://canonical",
		});
		expect(readFileSync(first.path, "utf8")).toBe(`{
  "providers": {
    "anthropic-subscription": { "baseUrl": "https://canonical", "models": [] }
  }
}
`);
	});

	it("is a no-op on the second load and on an already canonical file", () => {
		const { dir, path } = modelsJsonFile(LEGACY_JSONC);
		ModelConfig.loadSync(path);
		const migrated = readFileSync(path, "utf8");
		const mtime = statSync(path).mtimeMs;
		ModelConfig.loadSync(path);
		expect(readFileSync(path, "utf8")).toBe(migrated);
		expect(statSync(path).mtimeMs).toBe(mtime);
		expect(backups(dir)).toHaveLength(1);

		const canonical = modelsJsonFile('{ "providers": { "anthropic": { "baseUrl": "https://x", "models": [] } } }');
		ModelConfig.loadSync(canonical.path);
		expect(backups(canonical.dir)).toEqual([]);
	});

	it("keeps the file mode of the original", () => {
		const { path } = modelsJsonFile(LEGACY_JSONC);
		chmodSync(path, 0o640);
		ModelConfig.loadSync(path);
		expect(statSync(path).mode & 0o777).toBe(0o640);
	});

	it("leaves the file untouched and warns with the reason when the rewrite cannot be written", () => {
		const { dir, path } = modelsJsonFile(LEGACY_JSONC);
		mkdirSync(`${path}.${process.pid}.tmp`);
		const config = ModelConfig.loadSync(path);

		expect(readFileSync(path, "utf8")).toBe(LEGACY_JSONC);
		expect(backups(dir)).toEqual([]);
		expect(config.getWarnings()).toHaveLength(1);
		expect(config.getWarnings()[0]).toContain("openai-codex -> chatgpt-subscription");
		expect(config.getWarnings()[0]).toContain("could not be updated automatically");
		expect(config.getProvider("chatgpt-subscription")).toBeDefined();
	});

	it("does not rewrite a file whose schema is invalid", () => {
		const invalid = '{ "providers": { "openai-codex": { "models": "not-an-array" } } }';
		const { dir, path } = modelsJsonFile(invalid);
		expect(ModelConfig.loadSync(path).getError()).toContain("Invalid models.json schema");
		expect(readFileSync(path, "utf8")).toBe(invalid);
		expect(backups(dir)).toEqual([]);
	});
});
