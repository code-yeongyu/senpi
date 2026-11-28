import { createHash } from "node:crypto";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import bashTimeoutExtension from "../../src/core/extensions/builtin/bash-timeout/index.ts";
import imageGenExtension from "../../src/core/extensions/builtin/imagegen/index.ts";
import { presetSharedSections } from "../../src/core/extensions/builtin/prompt-preset/contract.ts";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";
import {
	AUTO_RESOLVED_PRESET_NAMES,
	buildDynamicSystemPrompt,
	resolvePreset,
} from "../../src/core/extensions/builtin/prompt-preset/public.ts";
import type { PromptPresetName } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";
import terminalExtension from "../../src/core/extensions/builtin/terminal/index.ts";
import todowriteExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import webfetchExtension from "../../src/core/extensions/builtin/webfetch/index.ts";
import websearchExtension from "../../src/core/extensions/builtin/websearch/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";
import { BASELINE_OPTIONS, BASELINE_SURFACES, WORKSTATION_FACTS } from "./prompt-presets-baseline-fixtures.ts";

// senpi#5665: the Opus and Fable presets render the shared sections as they were before the senpi#5335
// diet (main 037918157); every other preset and the default prompt render them as on main 836fe1c75.
// Each expected value is the sha256 of the prompt rendered at that source commit, re-pinned where a later
// change moved the tool surface: senpi#6272 made generate_image eval-only, so the eval variants name
// tool.generate_image in the eval-only paragraph and the no-eval variants list it as a direct tool; senpi#6358
// replaced the smallest-change rule with the ownership rule in every core and in the shared Style, Intent Gate
// and claim-audit sentences, so every hash is re-pinned to that rendering (the full/diet split is unchanged).
// senpi#6681 named the `<device>/<session>` monitor target in the terminal prompt's rpc line;
// every REQUEST_ROWS hash (both sources) is re-pinned; PRESET_ROWS are unchanged.

vi.mock("../../src/core/dynamic-prompt/workstation.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/dynamic-prompt/workstation.ts")>();
	return {
		...actual,
		buildWorkstationSection: (options: Parameters<typeof actual.buildWorkstationSection>[0]) =>
			actual.buildWorkstationSection({ ...options, facts: WORKSTATION_FACTS }),
	};
});

const serverSearch = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/core/extensions/builtin/websearch/server-search.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/extensions/builtin/websearch/server-search.ts")>();
	return {
		...actual,
		hasServerSearch: (model: Parameters<typeof actual.hasServerSearch>[0]) =>
			serverSearch.on || actual.hasServerSearch(model),
	};
});

type SourceCommit = "037918157" | "836fe1c75";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const FULL_PRESETS: readonly PromptPresetName[] = [
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-fable-5-2",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-5",
];

const PRESET_ROWS: ReadonlyArray<{
	readonly preset: PromptPresetName;
	readonly source: SourceCommit;
	readonly hashes: Readonly<Record<string, string>>;
}> = [
	{
		preset: "claude-fable-5",
		source: "037918157",
		hashes: {
			"terminal:0": "95a18dc9471f5f04bf12715b10e104809ee54393c9cc1ede0f6f5937999ca65e",
			"terminal:1": "53a1ae738258ba1b4eac67be8be9aaa79d2d17b6134b2756f0117eb42dd4303c",
			"app:0": "d085ff0a62ccba956b848d1b0ebc8dc9ef568648a89446963d323ca34f3e0334",
			"app:1": "e357f46b767941a79c73f4bf94ccd47551e0e7069fb4fc91591fdbada61e515c",
			"chat:0": "2637c07bcdd9814af8eb611ad29560ab055e4104d25a215b11ca0b3da6e28c7a",
			"chat:1": "dd1462b68b08e040d7c088600d93ff2f38fa6611c11a4df28e53719150346ebb",
		},
	},
	{
		preset: "claude-fable-5-1",
		source: "037918157",
		hashes: {
			"terminal:0": "96282d059933bc36d5c85b21a0c75e74e24cc8df5f4688045df1b3a7859e7e03",
			"terminal:1": "838f5b966ec8ed5d09d2e54cedcae9ce04106b3c39f47dfa3d1d6a8e6b86c673",
			"app:0": "dbcf76d53a9ec5101763a9f7767ac0366ed84abc7f16b95af4e312b5d5af1adc",
			"app:1": "fc06172edb1fe6ac42f2c7e201b8c85ac63b470365cb4793450d2494738417ae",
			"chat:0": "8cabbaf8f8eee4dad6693b42c68c1a27cceecc06155e7db8957e07c00d5f747d",
			"chat:1": "b1e43c96d407f75402915e282c5a65f02498b4f3a5ffc7ce945870bfdc0b7348",
		},
	},
	{
		preset: "claude-fable-5-2",
		source: "037918157",
		hashes: {
			"terminal:0": "dafa97044d82012af3ffb5fdb33a651c290cea7c7c09adf1f7f72bae3ec71120",
			"terminal:1": "21c96738487c1bf9b125cfe9f46b534acb23a72c57ba643537e60f430e2f32e4",
			"app:0": "b94983534cd8cd8f086670f96a0fac69e426fc5a5338f52ef4be225e7e1f0cb9",
			"app:1": "79e346e07218ab460d152692e8fe3ec532073ed56cb903c31cb482a0322b0c43",
			"chat:0": "25ace3ce46102dadfa5225ad60d9088b818d6a5e8e7fac7fca17ca261a0132a7",
			"chat:1": "82b740f5b7529a8924a3ce35977c87d26c8189889d7aea412b240838e9312557",
		},
	},
	{
		preset: "claude-opus-5-5",
		source: "037918157",
		hashes: {
			"terminal:0": "884982e11fe331736b2b55f202825f26f270405371c845888307ecc2c0d8a771",
			"terminal:1": "73836c48615dd8b81a6b249349d6787571bc1528f044c30116a720d6ba4a49f7",
			"app:0": "b8b0be00f34850de4f31d876f2e539057e9e93095e712c54fbe0a7493532d9ea",
			"app:1": "18371215825a2dcb9f698007dcd0ef6e22ee1fd8dcbb9ca22065ac72bf1361cf",
			"chat:0": "6d19fb22cf2a15dbc2c8f41532abd264fdfa8d3320b26a0c2f157093630816c7",
			"chat:1": "d3d597a1f51068b2553fb74224e5d31b2b321550e868cc588c1cddbc467b7940",
		},
	},
	{
		preset: "claude-opus-5",
		source: "037918157",
		hashes: {
			"terminal:0": "665439c8e4f153fcaab719eaf958994c38a6178ca1c17f22c6ef7208da31e508",
			"terminal:1": "b13cdec68457cbf359ecd85644db54fa1d4919795f5e406597b449eff70964df",
			"app:0": "da91a3c16be9a9f476ace87ad957c073d3ad8edd550072a2969c833d0b10e995",
			"app:1": "247766add3c0590ae8631e27be572e8b67d5bf05ab257143f429bac1cff26ed3",
			"chat:0": "b5aad9b56a99c9428bf244e3ed0f8fdc095ecb8fb041dc7dce1dd72e06f59b32",
			"chat:1": "279a84dfb3da54b5ec0e3a35fe34c73a0958bc521f8c9b740fc4b1ac95c9ac2b",
		},
	},
	{
		preset: "claude-opus-4-8",
		source: "037918157",
		hashes: {
			"terminal:0": "99c51bc4db60395f9f3440f8aedc3f0bf333a6054c61a847b97266f5d6467d00",
			"terminal:1": "b470ccbe07a3d36b66e6a590a97b32a9f99367db56dbc56345d5068d2c1b22ef",
			"app:0": "e07440b833f35c07c5100cd3d0968915e74a3472767d3972aa9fcc7b19dd361d",
			"app:1": "487eeb2736a88e7a54904454adc45018d169327210e19222d422b4e42e78df22",
			"chat:0": "02263b1fb37e77a04abfd99fd83fe66a9fd2362430a6348de1dab3539596e98f",
			"chat:1": "b4a4b308ee2d2a9ed20a985d494e4f8e8effbc0a84a38cae977b9a41bae71755",
		},
	},
	{
		preset: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"terminal:0": "c31936ab02b3cccdc33f2844faa693217d11bae3a6cc1216cd42475303f4577b",
			"terminal:1": "e613ed4b0e43f5128be1f28d2a487da04ab9a1c093a7771c22957b9727ded277",
			"app:0": "3859ca19e904eccfa1e791b0e8a98d8fabbd239e7d5f0e4697b0ced1f3bacd61",
			"app:1": "cf59e5ed4688ae59c737c48f15eae0665a855dc8ae115387808b3e43ab44a4c6",
			"chat:0": "dddb97c6bcd4edd45a91df1ec114ead772339346b7f670a81e1547dc583dcae7",
			"chat:1": "be4df5b44fe8e9c98010c780437baad360ba52ef369d687f380d9661512e766a",
		},
	},
	{
		preset: "claude-opus-4-6",
		source: "037918157",
		hashes: {
			"terminal:0": "919681cfa3e9ba48640160d4fd32990e735a519dfecdc3964175ccf689525c7c",
			"terminal:1": "acd216ed98ae1e7e10dec86d00388bc108449b52b4d520535326ca15eeb842c1",
			"app:0": "d4ae533f21138fafe2f43171814962869ab954e37f6642fcf2474b1797cfd325",
			"app:1": "283c562cbad99a02917501ecdd60888b82bebaf6dce4c37e91a4493dc65b4d59",
			"chat:0": "7aab372677ca8ad16bd81e7027ff0a5118b53f7ad632f84855caf95ab961bf20",
			"chat:1": "a04cdb260aa0b9829a56680505b35b2cd7730a7becfbc782966d5aa3e6fcf134",
		},
	},
	{
		preset: "claude-opus-4-5",
		source: "037918157",
		hashes: {
			"terminal:0": "7da076e3bf1d3860d5de77588d98b859569884e0914cba49e2bf041691765649",
			"terminal:1": "ee33cc7d95fb3f5f2235f6b32d805a8d954ead7b7160f6f2f29303bf0cb88527",
			"app:0": "955bc12eef68abb57ba3e6205d1d51acc1609d476d899ea9c67f99003bfeea37",
			"app:1": "b0459e4d103b912c7c850a97a7368ed3b4c714840c9bc67f941ea3a642c61f9e",
			"chat:0": "17db2cee739329d477c639a73484344fd7ca0407cf9f96afb29683fd6a56fa36",
			"chat:1": "2d704da591ab8ba2f88bc5d0a84a7dec630da4670d2d86a2ce91691dd9c8b6f7",
		},
	},
	{
		preset: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "1a3d166512ed3772a6e9becdcf9d80a2ddad6829a95a0b8d07f48f49e8f314bd",
			"terminal:1": "4803e822a2f079f1bfe62ff5a96e7d6459c892f4a9cf394dd7f6caf749f0f1de",
			"app:0": "30ae9236f16f72f1102df36c89a571f29860bf26c660860d17f0e00eeb449c13",
			"app:1": "88f709f43c578db665759d20836a776ade5c666e8a5e310d17e0f2ea20c60498",
			"chat:0": "cd12b888362b807fedadac2453b0c1ed570da9b9a354d73f4671c011ffed34be",
			"chat:1": "fb0b3dc8b45f3e7a25312389e0dcd47628a6fd953510a0d1905968127be90ea3",
		},
	},
	{
		preset: "gpt-6-astra",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "d552b2ae88130fb8fbdab9682839bb18b9860921f53001fad2900a50b6360dbb",
			"terminal:1": "9267aa5449ade7b94d64db2adff4d00c687b92fd82f3b345ba7c9538900d29e5",
			"app:0": "846f1fa7b391c2188272e59ceffb6d8a9684d5f78aa96132b7abce487b41366b",
			"app:1": "714ca5680d1859ecaae7abf3bcb0ebe8645a6c5e863ed1fd187f6b8ee9abaae6",
			"chat:0": "c5ad43bd2110cc51c5c6ec9037c9ce78d18bda2a466db593c1d217f2a0abe7a9",
			"chat:1": "27c27ab3919c67124f33afced3271ee22d043a97b7659ff1617e8015f4e4abfa",
		},
	},
	{
		preset: "auto",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "02d95f7d57f395d6da1b02999cb0cb0ac3b17226fdbfa900f727673c1e7d4ca9",
			"terminal:1": "f86f0312e717113aff16a4b3fa0efc604b2aa36109b7f6a8a24db20c8d1c893c",
			"app:0": "1407d75710e85e0d84852874a83d560b5641ad22cb63f39eeed249265af6e4d0",
			"app:1": "70d85fec25838835d8f9bb7b72f6d9bb987f3add1f8e72a442340383696f7a28",
			"chat:0": "9ebb93a78d171d46f94d6422f7455aa1130c7d8582a8ff767d4b42b583e808db",
			"chat:1": "97fb97a85423cda9121dd03e9341b16369acdbeb79891847d0d1f045ada49668",
		},
	},
];

const VARIANTS = {
	"eval-false": { eval: false },
	"eval-true": { eval: true },
	"app-eval-true": { eval: true, app: true },
	"app-eval-false": { eval: false, app: true },
	"search-eval-true": { eval: true, serverSearch: true },
	"nativebash-eval-false": { eval: false, nativeBash: true },
	"nativebash-eval-true": { eval: true, nativeBash: true },
} as const satisfies Record<string, { eval: boolean; app?: true; serverSearch?: true; nativeBash?: true }>;

type VariantName = keyof typeof VARIANTS;

const REQUEST_ROWS: ReadonlyArray<{
	readonly modelId: string;
	readonly source: SourceCommit;
	readonly hashes: Readonly<Partial<Record<VariantName, string>>>;
}> = [
	{
		modelId: "claude-opus-5.5",
		source: "037918157",
		hashes: {
			"eval-false": "ec6c8e4ca3c8ffd2bd177f3bfb15adf22232c25fd7ae9d161beb62bb9ea4768d",
			"eval-true": "ad3620046fd5ba1ab8a4f2bd25323ee7f3e385f34f8d66581cc1e39835b14027",
			"app-eval-true": "31219f0d94fbc022fa8303781762b129956f3d499e19f8a16dc71f91e451e638",
			"search-eval-true": "dc9dba5c5c20d81a2624d16e1da134c501f020060a919d334b29d9fa177b96ec",
		},
	},
	{
		modelId: "claude-fable-5.1",
		source: "037918157",
		hashes: {
			"eval-false": "10d9a2c744ce4e3a0c800775f1f480ae050b78d9d53f28ca6728c97d34539e11",
			"eval-true": "bf9030af07cbc6ffecb6f0fec23d5ad7fa93cbe012ebd78462992d20bd6ca5b9",
			"app-eval-true": "ebe67d18176e39e50797269988d648d1a3483ac5eb7709a7d70db5896c08d57e",
			"search-eval-true": "de30a328f4e8ea5b3b23fa6e8a52f2b138b436d4bee1a6a05da74281f92ff015",
		},
	},
	{
		modelId: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"eval-false": "2628117c32a176d9d1a883cbc253c0f2031054f4b8a25392ad4756f014c9d131",
			"eval-true": "fc263ff97eb9d535c5aedad08a31746ef6770bd343d279f6ef87ee6202b1e59d",
			"app-eval-true": "2064b3dabe521dca5572752c1623f55d6e28734b4c073611f708ad2bf34634d5",
			"search-eval-true": "852118baadd271796eeb5bafe0a42a63d6161872d6fcc163da07bab57c3cb8dc",
		},
	},
	{
		modelId: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"eval-false": "432b8496bcd913d4716f01ce68d5c567f7cc68ccf2aa3e96bc1388e56633b23d",
			"eval-true": "03c66acdcca22692a36a2d2eb8e0f3e6a3d3bbaf464d04404d892147134a7bd0",
			"app-eval-true": "0186d93627b9038b38e211daa3c03b0ce18b9830aa848aad872d4387f8761953",
			"search-eval-true": "522ed1181f260b5ee8849e402a5f536a3ecf046c9f6f7fc95123a274c8183812",
		},
	},
	{
		// This is the GPT-6 family baseline, still shipped for Sol after Astra moved to the 6.2 core.
		modelId: "gpt-6-sol",
		source: "836fe1c75",
		hashes: {
			"eval-false": "cd0bf8ee355421933235ff9b63bb68259f72b6e0313ae148efdf296fc54d11ee",
			"eval-true": "bfa832a2fd20275bafa0b3ea0894904ec31a28944e65c866292cc71b4ca39c3e",
			"app-eval-true": "cfc0f4b5008b09f21d63fc4d991b929be773ed154af96b8cf1d11d8c024c700d",
			"app-eval-false": "65590f489f8f2a931ae3a00a299c3626c17d20756e1bb4ccf5e1157380c5684a",
			"search-eval-true": "17c35f8f0782de693851c0d3af18010e2ecd801ccaeaa6c334e26c794fa818df",
			"nativebash-eval-false": "cd0bf8ee355421933235ff9b63bb68259f72b6e0313ae148efdf296fc54d11ee",
			"nativebash-eval-true": "bfa832a2fd20275bafa0b3ea0894904ec31a28944e65c866292cc71b4ca39c3e",
		},
	},
	{
		modelId: "test-default-model",
		source: "836fe1c75",
		hashes: {
			"eval-false": "feb48678ca2d44bcf9ea5e7f140b3f5830e437974d2ca880364ccfdcf4040904",
			"eval-true": "61eb53ff93fad4f4d4f8e0240e6dd41cb005c79e76ab201e2b7442a962148259",
			"app-eval-true": "2343c7c6c8b52b2ad180638d78e2af4c1cd19ac5fad10c616d95b85f86a8a731",
			"search-eval-true": "f3e84ac3c52dfa8057dcb525a0d28e89a1a00449c446fd211784a44b847edb07",
		},
	},
];

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
	serverSearch.on = false;
});

/** The first-turn system prompt with the default tools and the builtins that append shared prompt text. */
async function firstTurnPrompt(modelId: string, variant: (typeof VARIANTS)[VariantName]): Promise<string> {
	if ("app" in variant) vi.stubEnv("SENPI_PROMPT_SURFACE", "app");
	vi.stubEnv("PI_ANTHROPIC_BASH", "nativeBash" in variant ? "1" : "0");
	serverSearch.on = "serverSearch" in variant;
	const extensionFactories: Array<{ factory: ExtensionFactory; path: string }> = [
		{ factory: imageGenExtension, path: "<builtin:imagegen>" },
		{ factory: promptPresetExtension, path: "<builtin:prompt-preset>" },
		{ factory: todowriteExtension, path: "<builtin:todowrite>" },
		{ factory: bashTimeoutExtension, path: "<builtin:bash-timeout>" },
		{ factory: terminalExtension, path: "<builtin:terminal>" },
		{ factory: websearchExtension, path: "<builtin:websearch>" },
		{ factory: webfetchExtension, path: "<builtin:webfetch>" },
	];
	if (variant.eval) {
		extensionFactories.push({
			path: "/fixture/eval.ts",
			factory: (pi) => {
				pi.registerTool({
					name: "eval",
					label: "eval",
					description: "Evaluate code.",
					promptSnippet: "Run one incremental code cell.",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
				});
			},
		});
	}
	const openai = modelId.startsWith("gpt");
	const harness = await createHarness({
		extensionFactories,
		api: openai ? "openai-responses" : "anthropic-messages",
		provider: openai ? "openai" : modelId.startsWith("glm") ? "zai" : "anthropic",
		models: [{ id: modelId, reasoning: false }],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const build = harness.getExtensionRunner().createContext().getPromptCachePrefixRequest;
	if (!build) throw new Error("Missing prefix builder");
	const result = await build({ sizesOnly: true });
	if (result.status !== "ready") throw new Error(result.reason);
	return (result.request.context.systemPrompt ?? "").split(harness.tempDir).join("<TMP>");
}

describe("shared sections per preset (senpi#5665)", () => {
	it("declares full shared sections for exactly the Opus and Fable presets", () => {
		for (const name of ["gpt-5", ...AUTO_RESOLVED_PRESET_NAMES] as const) {
			expect(presetSharedSections(name), name).toBe(FULL_PRESETS.includes(name) ? "full" : "diet");
		}
		expect(presetSharedSections(undefined)).toBe("diet");
		expect(presetSharedSections("gpt-6-astra")).toBe("diet");
	});

	it.each(PRESET_ROWS)("renders $preset byte-equal to $source on every surface and option", ({ preset, hashes }) => {
		for (const surface of BASELINE_SURFACES) {
			for (const [index, input] of BASELINE_OPTIONS.entries()) {
				const options = { ...input, surface };
				const rendered = resolvePreset({ provider: "synthetic", id: "unknown" }, { promptPreset: preset }, options);
				const prompt = rendered?.prompt ?? buildDynamicSystemPrompt(options);
				expect(sha256(prompt), `${preset}:${surface}:${index}`).toBe(hashes[`${surface}:${index}`]);
			}
		}
	});

	describe.each(REQUEST_ROWS)("first-turn prompt with tools for $modelId equals $source", ({ modelId, hashes }) => {
		it.each(Object.entries(hashes))("%s", async (variantName, expected) => {
			const prompt = await firstTurnPrompt(modelId, VARIANTS[variantName as VariantName]);
			expect(sha256(prompt)).toBe(expected);
		});
	});

	it.each(Object.keys(VARIANTS) as VariantName[])(
		"shares the assembled GPT-6.2 first-turn prompt with Astra: %s",
		async (variantName) => {
			const variant = VARIANTS[variantName];
			const astra = await firstTurnPrompt("gpt-6-astra", variant);
			const astra62 = await firstTurnPrompt("gpt-6.2-astra", variant);
			expect(astra).toBe(astra62);
		},
	);
});
