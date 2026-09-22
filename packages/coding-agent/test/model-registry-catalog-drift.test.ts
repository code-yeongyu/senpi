import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache } from "../src/core/model-registry.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const testDir = dirname(fileURLToPath(import.meta.url));

/** Fixture files whose modelOverrides fixtures address the bundled catalog. */
const FIXTURE_FILES = ["model-registry.test.ts", "model-registry-recovery-config.test.ts"] as const;

type FixtureFile = (typeof FIXTURE_FILES)[number];

/**
 * Fixtures that intentionally address an id the catalog does not carry. They
 * assert the override is ignored, so absence is the contract, not drift.
 */
const intentionallyAbsent: Partial<Record<FixtureFile, readonly string[]>> = {
	"model-registry.test.ts": ["nonexistent/model-id"],
	"model-registry-recovery-config.test.ts": ["unknown/recovery-model"],
};

const CATALOG_DATA_DIR = "packages/ai/src/providers/data";

function missingFixtureError(file: string, provider: string, id: string, kind: string): Error {
	return new Error(
		`${file}: ${kind} addresses a model the ${provider} catalog does not carry: "${id}". ` +
			`A modelOverrides entry only ever decorates a model the bundled catalog already has, so this fixture can never ` +
			`assert anything - its field checks report "expected undefined to be ...", naming neither provider nor id. ` +
			`Point it at an id the catalog still ships (see ${CATALOG_DATA_DIR}/${provider}.json). senpi#1955, senpi#1945.`,
	);
}

/**
 * Read the quoted string starting at source[start]; return its value and the index just after the closing quote.
 */
function readQuotedString(source: string, start: number): { value: string; end: number } | undefined {
	for (let i = start + 1; i < source.length; i++) {
		const ch = source[i];
		if (ch === '"') return { value: source.slice(start + 1, i), end: i + 1 };
	}
	return undefined;
}

/**
 * The provider a modelOverrides occurrence is configured for. Within the
 * enclosing test block, the nearest preceding line that opens an object under
 * a plain key is the provider block ("openrouter: {" or "\"extension-provider\": {").
 * A config bound to a const first (const provider: ModelsJsonProvider = {)
 * has no such line, so the provider is read from the write call that submits
 * it: the first key inside writeRawModelsJson({ ... })/writeModelsJson({ ... }).
 */
function providerFor(source: string, at: number): string {
	const before = source.slice(0, at);
	const testStart = before.lastIndexOf("\n\t\ttest(") === -1 ? 0 : before.lastIndexOf("\n\t\ttest(");
	const lines = source.slice(testStart, at).split("\n");
	for (const line of lines.reverse()) {
		const match = line.match(/^\s*"?([A-Za-z][\w-]*)"\s*:\s*\{$|^\s*([A-Za-z][\w-]*)\s*:\s*\{$/);
		const key = match?.[1] ?? match?.[2];
		if (key) return key;
	}
	const after = source.slice(at);
	const call = after.match(/write(?:Raw)?ModelsJson\(\{\s*(?:\n\s*)?([A-Za-z][\w-]*|"[^"]+")\s*[:,}]/);
	if (call?.[1]) return call[1].replace(/^"|"$/g, "");
	throw new Error("could not determine the provider for a modelOverrides fixture - update the drift guard");
}

/**
 * Every modelOverrides block's top-level quoted keys with their provider. An
 * override only decorates a model the catalog already carries, so a key the
 * catalog dropped can never assert anything (senpi#1955, senpi#1945).
 */
function extractModelOverrideKeys(source: string): Array<{ provider: string; id: string }> {
	const entries: Array<{ provider: string; id: string }> = [];
	for (const match of source.matchAll(/modelOverrides\s*:\s*\{/g)) {
		const provider = providerFor(source, match.index ?? 0);
		let depth = 1;
		let i = (match.index ?? 0) + match[0].length;
		while (i < source.length && depth > 0) {
			const ch = source[i];
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			else if (depth === 1 && ch === '"') {
				const key = readQuotedString(source, i);
				if (!key) throw new Error("unterminated string in a modelOverrides fixture - update the drift guard");
				entries.push({ provider, id: key.value });
				i = key.end;
				continue;
			}
			i++;
		}
	}
	return entries;
}

/**
 * Contrast-model lookups inside the modelOverrides describe block: ids compared
 * with '=== "a/b"' that no fixture declares as a custom model. They back the
 * "other model is unaffected" assertions; a retired id turns them vacuous or
 * red with "expected undefined to be ..." (senpi#1955's first failure was
 * exactly this, via the provider-level compat contrast model).
 */
function extractContrastIds(source: string): string[] {
	const start = source.indexOf('describe("modelOverrides');
	if (start === -1) {
		throw new Error(
			'model-registry.test.ts no longer has a describe("modelOverrides") block - update the drift guard',
		);
	}
	const next = source.indexOf('\n\tdescribe("', start + 1);
	const block = source.slice(start, next === -1 ? undefined : next);
	const declared = new Set([...source.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]));
	const absent = new Set(intentionallyAbsent["model-registry.test.ts"] ?? []);
	return [...block.matchAll(/=== "([^"/]+\/[^"]+)"/g)]
		.map((m) => m[1])
		.filter((id): id is string => id !== undefined && !declared.has(id) && !absent.has(id));
}

describe("modelOverrides fixture drift guard", () => {
	let tempDir: string;
	let modelsJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-catalog-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearApiKeyCache();
		vi.restoreAllMocks();
	});

	test("every catalog-addressed fixture id exists in the bundled catalog", async () => {
		// Empty providers: the registry then carries exactly the bundled catalog,
		// the same surface an override decorates in production.
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: {} }));
		const registry = await createModelRegistry(AuthStorage.inMemory(), modelsJsonPath);
		const bundledProviders = new Set(registry.getAll().map((model) => model.provider));

		// Overrides on a provider the bundled catalog does not carry (e.g. the
		// extension-provider fixture) decorate models the test registers at
		// runtime; they cannot drift against the catalog, so they are out of scope.
		const seen = new Set<string>();
		const overrideEntries: Array<{ file: string; provider: string; id: string }> = [];
		for (const file of FIXTURE_FILES) {
			const source = readFileSync(join(testDir, file), "utf8");
			const absent = new Set(intentionallyAbsent[file] ?? []);
			for (const { provider, id } of extractModelOverrideKeys(source)) {
				if (absent.has(id) || !bundledProviders.has(provider)) continue;
				const key = `${file}:${provider}:${id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				overrideEntries.push({ file, provider, id });
			}
		}
		if (overrideEntries.length === 0) {
			throw new Error("no catalog-addressed modelOverrides fixtures found - the drift guard went blind; update it");
		}

		// The named check runs first so a retired id reports provider, id and
		// catalog file, never a bare "expected undefined to be ...".
		for (const { file, provider, id } of overrideEntries) {
			if (!registry.find(provider, id)) throw missingFixtureError(file, provider, id, "modelOverrides entry");
		}

		// Pin the scanner: these fixtures exist today, so a miss AFTER the named
		// check above means the extraction changed shape and went blind.
		expect(overrideEntries).toContainEqual({
			file: "model-registry.test.ts",
			provider: "openrouter",
			id: "anthropic/claude-sonnet-4",
		});
		expect(overrideEntries).toContainEqual({
			file: "model-registry.test.ts",
			provider: "openrouter",
			id: "anthropic/claude-opus-4.1",
		});
		expect(overrideEntries).toContainEqual({
			file: "model-registry-recovery-config.test.ts",
			provider: "openrouter",
			id: "anthropic/claude-opus-4.1",
		});

		const contrastIds = extractContrastIds(readFileSync(join(testDir, "model-registry.test.ts"), "utf8"));
		expect(contrastIds.length).toBeGreaterThanOrEqual(2);
		for (const id of contrastIds) {
			if (!registry.find("openrouter", id)) {
				throw missingFixtureError("model-registry.test.ts", "openrouter", id, "contrast-model lookup");
			}
		}
	});
});
