import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertExactModelIds,
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	MODEL_DATA_SCHEMA_VERSION,
	type ModelDataStructure,
	readModelDataStructure,
	stableGeneratedAt,
	validateModelDataDirectory,
} from "../scripts/model-data.ts";

const GENERATED_AT = "2026-07-23T10:00:00.000Z";

describe("stableGeneratedAt (idempotent catalog generation)", () => {
	const structure: ModelDataStructure = { "test-provider": { "chat:model-a": "openai-completions" } };
	const newer = "2026-10-13T04:00:00.000Z";

	it("keeps the committed generatedAt when the content is unchanged", () => {
		const committed = createModelDataManifest(structure, {}, GENERATED_AT);
		const regenerated = createModelDataManifest(structure, {}, newer);
		expect(stableGeneratedAt(regenerated, committed)).toBe(GENERATED_AT);
		// regenerate twice with unchanged data -> byte-identical, so the drift check stays green
		expect(stableGeneratedAt(createModelDataManifest(structure, {}, "2026-10-14T00:00:00.000Z"), committed)).toBe(
			GENERATED_AT,
		);
	});

	it("moves the timestamp when a model is added or removed", () => {
		const committed = createModelDataManifest(structure, {}, GENERATED_AT);
		const changed: ModelDataStructure = { "test-provider": { "chat:model-b": "openai-completions" } };
		expect(stableGeneratedAt(createModelDataManifest(changed, {}, newer), committed)).toBe(newer);
	});

	it("moves the timestamp when only a model field changes (cost, context, baseUrl)", () => {
		const committed = createModelDataManifest(structure, { "a.json": "old" }, GENERATED_AT);
		// same model set, different file contents: the timestamp must move, not stay stale
		expect(stableGeneratedAt(createModelDataManifest(structure, { "a.json": "new" }, newer), committed)).toBe(newer);
	});

	it("uses the fresh timestamp when there is no committed manifest", () => {
		expect(stableGeneratedAt(createModelDataManifest(structure, {}, newer), undefined)).toBe(newer);
	});
});
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createFixture(): {
	dataDir: string;
	packageRoot: string;
	structure: ModelDataStructure;
	values: Record<string, unknown>;
} {
	const packageRoot = mkdtempSync(join(tmpdir(), "pi-model-data-"));
	temporaryRoots.push(packageRoot);
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(packageRoot, "src", "models.generated.ts"),
		'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	writeFileSync(
		join(providersDir, "test-provider.models.ts"),
		'import values from "./data/test-provider.json" with { type: "json" };\n',
	);

	const structure: ModelDataStructure = {
		"test-provider": {
			"chat:model-a": "openai-completions",
		},
	};
	const values: Record<string, unknown> = {
		"chat:model-a": {
			type: "chat",
			id: "model-a",
			name: "Model A",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
	};
	writeFixtureData(dataDir, structure, values);
	return { dataDir, packageRoot, structure, values };
}

function writeFixtureData(
	dataDir: string,
	structure: ModelDataStructure,
	values: Record<string, unknown>,
	manifestSchemaVersion = MODEL_DATA_SCHEMA_VERSION,
	apiGroup = "openai-completions",
): void {
	const filename = "test-provider.json";
	const content = `${JSON.stringify({ [apiGroup]: values })}\n`;
	writeFileSync(join(dataDir, filename), content);
	const manifest = createModelDataManifest(structure, { [filename]: content }, GENERATED_AT);
	manifest.schemaVersion = manifestSchemaVersion;
	writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
}

describe("generated model data validation", () => {
	it("rejects a missing upstream model from an exact generated allowlist", () => {
		expect(() => assertExactModelIds("qwen-token-plan-individual", ["model-a", "model-b"], ["model-a"])).toThrow(
			"qwen-token-plan-individual model IDs do not match (missing: model-b)",
		);
	});

	it("rejects an unexpected model from an exact generated allowlist", () => {
		expect(() => assertExactModelIds("test-provider", ["model-a"], ["model-a", "model-b"])).toThrow(
			"test-provider model IDs do not match (extra: model-b)",
		);
	});

	it("reads and validates API-grouped model data", () => {
		const { dataDir, packageRoot, structure } = createFixture();
		expect(readModelDataStructure(packageRoot)).toEqual(structure);
		expect(() => validateModelDataDirectory(structure, dataDir)).not.toThrow();
	});

	it("accepts video input metadata", () => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		model.input = ["text", "image", "video"];
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).not.toThrow();
	});

	it("rejects a missing model data directory", () => {
		const { dataDir, structure } = createFixture();
		rmSync(dataDir, { recursive: true });
		expect(() => validateModelDataDirectory(structure, dataDir)).toThrow("does not exist");
	});

	it.each([
		["id", "wrong-id", "has id"],
		["provider", "wrong-provider", "has provider"],
		["api", "anthropic-messages", "has api"],
	] as const)("rejects a wrong model %s", (field, value, expectedMessage) => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		model[field] = value;
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(expectedMessage);
	});

	it("accepts a dated cost card", () => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		model.cost = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			effectiveRates: [{ effectiveFrom: "2026-12-01T08:00:00Z", input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }],
		};
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).not.toThrow();
	});

	it.each([
		["an empty card list", [], "invalid cost.effectiveRates"],
		[
			"a local-time start",
			[{ effectiveFrom: "2026-12-01T00:00:00", input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }],
			"invalid effectiveFrom",
		],
		[
			"a date-only start",
			[{ effectiveFrom: "2026-12-01", input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }],
			"invalid effectiveFrom",
		],
		[
			"a missing rate",
			[{ effectiveFrom: "2026-12-01T08:00:00Z", input: 2, output: 4, cacheRead: 0 }],
			"invalid cacheWrite",
		],
		[
			"a negative rate",
			[{ effectiveFrom: "2026-12-01T08:00:00Z", input: -2, output: 4, cacheRead: 0, cacheWrite: 0 }],
			"invalid input",
		],
		[
			"two cards starting together",
			[
				{ effectiveFrom: "2026-12-01T08:00:00Z", input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
				{ effectiveFrom: "2026-12-01T08:00:00.000Z", input: 3, output: 6, cacheRead: 0, cacheWrite: 0 },
			],
			"repeats effectiveFrom",
		],
	] as const)("rejects a malformed dated cost card: %s", (_case, effectiveRates, expectedMessage) => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		model.cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, effectiveRates };
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(expectedMessage);
	});

	it("rejects a model without a known type", () => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		delete model.type;
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(
			'expected "chat", "image", or "classifier"',
		);
	});

	it("validates image models with output modalities and without chat limits", () => {
		const fixture = createFixture();
		const structure: ModelDataStructure = { "test-provider": { "image:image-a": "test-images" } };
		const image: Record<string, unknown> = {
			type: "image",
			id: "image-a",
			name: "Image A",
			api: "test-images",
			provider: "test-provider",
			baseUrl: "https://example.test/v1",
			input: ["text"],
			output: ["image", "text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		};
		const validate = () => {
			writeFixtureData(
				fixture.dataDir,
				structure,
				{ "image:image-a": image },
				MODEL_DATA_SCHEMA_VERSION,
				"test-images",
			);
			validateModelDataDirectory(structure, fixture.dataDir);
		};
		expect(validate).not.toThrow();

		delete image.output;
		expect(validate).toThrow("invalid output modalities");
		image.output = ["text"];
		expect(validate).toThrow("invalid output modalities");
	});

	it("rejects output modalities on chat models", () => {
		const fixture = createFixture();
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		model.output = ["text"];
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(
			"unsupported output modalities",
		);
	});

	it("validates classifier models without chat output limits", () => {
		const fixture = createFixture();
		const structure: ModelDataStructure = {
			"test-provider": { "classifier:classifier-a": "test-classifier" },
		};
		const classifier = {
			type: "classifier",
			id: "classifier-a",
			name: "Classifier A",
			api: "test-classifier",
			provider: "test-provider",
			baseUrl: "https://example.test/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
		};
		writeFixtureData(
			fixture.dataDir,
			structure,
			{ "classifier:classifier-a": classifier },
			MODEL_DATA_SCHEMA_VERSION,
			"test-classifier",
		);
		expect(() => validateModelDataDirectory(structure, fixture.dataDir)).not.toThrow();
	});

	it("rejects a model in the wrong API group", () => {
		const fixture = createFixture();
		writeFixtureData(
			fixture.dataDir,
			fixture.structure,
			fixture.values,
			MODEL_DATA_SCHEMA_VERSION,
			"anthropic-messages",
		);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("grouped under API");
	});

	it("rejects duplicate model IDs across API groups", () => {
		const fixture = createFixture();
		const filename = "test-provider.json";
		const content = `${JSON.stringify({
			"openai-completions": fixture.values,
			"anthropic-messages": fixture.values,
		})}\n`;
		writeFileSync(join(fixture.dataDir, filename), content);
		const manifest = createModelDataManifest(fixture.structure, { [filename]: content }, GENERATED_AT);
		writeFileSync(join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("more than one API group");
	});

	it("rejects missing model IDs and stale file hashes", () => {
		const fixture = createFixture();
		writeFileSync(join(fixture.dataDir, "test-provider.json"), "{}\n");
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(/manifest hash|model IDs/);
	});

	it("rejects incompatible schema and generation stamps", () => {
		const fixture = createFixture();
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values, MODEL_DATA_SCHEMA_VERSION + 1);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("model data schema");

		const manifestPath = join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.structureHash = "stale";
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("generation stamp");
	});

	it("rejects an invalid generation timestamp", () => {
		const fixture = createFixture();
		const manifestPath = join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.generatedAt = "invalid";
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("generation timestamp");
	});

	it("rejects missing provider shards imported by the aggregator", () => {
		const { packageRoot } = createFixture();
		writeFileSync(
			join(packageRoot, "src", "models.generated.ts"),
			'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\nimport { MISSING_CLASSIFIER_MODELS, MISSING_IMAGE_MODELS, MISSING_MODELS } from "./providers/missing.models.ts";\n',
		);
		expect(() => readModelDataStructure(packageRoot)).toThrow("aggregator and provider shards do not match");
	});
});
