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
			"terminal:1": "08908c672dcbf7229e918a4650d4a53779b9b2030d6b32742188a334f318bf86",
			"app:0": "d085ff0a62ccba956b848d1b0ebc8dc9ef568648a89446963d323ca34f3e0334",
			"app:1": "a5b466a81fcd76d3aec4a29ddbd18b70d7e8d58eb31ab510a9885771d5d11f3f",
			"chat:0": "2637c07bcdd9814af8eb611ad29560ab055e4104d25a215b11ca0b3da6e28c7a",
			"chat:1": "b77a9cd7734ef2f53a62a64bfe381da9340e8154e1fa35bb488e43da4fbb87c7",
		},
	},
	{
		preset: "claude-fable-5-1",
		source: "037918157",
		hashes: {
			"terminal:0": "96282d059933bc36d5c85b21a0c75e74e24cc8df5f4688045df1b3a7859e7e03",
			"terminal:1": "c89337a3796eb37017fc4a5ab03344fe8f5bd92da4b8b0b653a8b5bd829b8dcb",
			"app:0": "dbcf76d53a9ec5101763a9f7767ac0366ed84abc7f16b95af4e312b5d5af1adc",
			"app:1": "883a7ff5dcf665bcd77dc2fb84fc3daf205e26623e261049b8c3f02c74fe5371",
			"chat:0": "8cabbaf8f8eee4dad6693b42c68c1a27cceecc06155e7db8957e07c00d5f747d",
			"chat:1": "0c2065825bac519dae1c3f36aeab30102b20561bbda696014d08222eae672c06",
		},
	},
	{
		preset: "claude-fable-5-2",
		source: "037918157",
		hashes: {
			"terminal:0": "571c8d17f3d7232d41e0a44436d57df04acb1a7545ab2e33600d46170286268d",
			"terminal:1": "6846e39f5edc8c2578791e200eb018b646f8b21847470ccfba84d9379a1192db",
			"app:0": "cccfab084a575ab56f876e77117bf14dfca0d1e6a8187389c7e50bef30f14927",
			"app:1": "899e773c0d8b3ae9e94e5e7e92c567ccbcf89c40dcea034eddf18f0aed276889",
			"chat:0": "77963d1a681f350c834ae5a3afc5bd9eff9b8e8025e3d9f7b9f3a9d52333df3b",
			"chat:1": "b074c2e044279770beb3fb02147fca06457566b03624f5a7e77af34f579390a5",
		},
	},
	{
		preset: "claude-opus-5-5",
		source: "037918157",
		hashes: {
			"terminal:0": "884982e11fe331736b2b55f202825f26f270405371c845888307ecc2c0d8a771",
			"terminal:1": "fa6c9cd9e5198aae6cf8dc207cd5d586ad70580122d983a49dedcc99435573c6",
			"app:0": "b8b0be00f34850de4f31d876f2e539057e9e93095e712c54fbe0a7493532d9ea",
			"app:1": "6f583324f8367c2c6fc8acde04fdaa9a67e1f42e8a15a912c7b71127180dcafe",
			"chat:0": "6d19fb22cf2a15dbc2c8f41532abd264fdfa8d3320b26a0c2f157093630816c7",
			"chat:1": "3d1f5121a9efd8e00e0ac57161a2eb23931983062d07bfa0b611311bca1a3fc9",
		},
	},
	{
		preset: "claude-opus-5",
		source: "037918157",
		hashes: {
			"terminal:0": "665439c8e4f153fcaab719eaf958994c38a6178ca1c17f22c6ef7208da31e508",
			"terminal:1": "df58c048a6105fc6768d304e7eea079611c80b50ef990d3acc79f47f503d2b79",
			"app:0": "da91a3c16be9a9f476ace87ad957c073d3ad8edd550072a2969c833d0b10e995",
			"app:1": "4897981ba64cb1bb5b84196bda906db90fba40d60c63b415d5d25bc15184caf3",
			"chat:0": "b5aad9b56a99c9428bf244e3ed0f8fdc095ecb8fb041dc7dce1dd72e06f59b32",
			"chat:1": "f814d02964c2fd10d8ebaa0e34221bdaa904b0d500f7c2cee550cd463b1e96bb",
		},
	},
	{
		preset: "claude-opus-4-8",
		source: "037918157",
		hashes: {
			"terminal:0": "99c51bc4db60395f9f3440f8aedc3f0bf333a6054c61a847b97266f5d6467d00",
			"terminal:1": "af4681e45a0ffb566a235a9f8f865c64b92e927a708eafa135798104aeb45ddb",
			"app:0": "e07440b833f35c07c5100cd3d0968915e74a3472767d3972aa9fcc7b19dd361d",
			"app:1": "d86c9917a776cc54abf68113c5ae53b8636915205b4b5d899eb11f98cc789d95",
			"chat:0": "02263b1fb37e77a04abfd99fd83fe66a9fd2362430a6348de1dab3539596e98f",
			"chat:1": "ce8c8f34e376ce0ab2c74486fcd4b3843377ade7706acf97683d6e0d9ee8da89",
		},
	},
	{
		preset: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"terminal:0": "c31936ab02b3cccdc33f2844faa693217d11bae3a6cc1216cd42475303f4577b",
			"terminal:1": "f104e00039035e7bc291f89d9614bac95b29c1abd3d849d2cd6a1f28ea06ccd9",
			"app:0": "3859ca19e904eccfa1e791b0e8a98d8fabbd239e7d5f0e4697b0ced1f3bacd61",
			"app:1": "1261cbbb6dd7f02809f9ea8ad1fca924cdcdff25ba2610fcdc2e0288cdffccc8",
			"chat:0": "dddb97c6bcd4edd45a91df1ec114ead772339346b7f670a81e1547dc583dcae7",
			"chat:1": "4cac4455eceff1957218d94f63b044a0514d68966c85557cfa8727364ae62530",
		},
	},
	{
		preset: "claude-opus-4-6",
		source: "037918157",
		hashes: {
			"terminal:0": "919681cfa3e9ba48640160d4fd32990e735a519dfecdc3964175ccf689525c7c",
			"terminal:1": "ca9d666e4eb55c8e98ea630d30ade599b88f9a37b8a2d5d47029122f2cd4b920",
			"app:0": "d4ae533f21138fafe2f43171814962869ab954e37f6642fcf2474b1797cfd325",
			"app:1": "50e4b7cfef4554fcbca24fc330a6f7e6ae30ecd0684556aad9f52023e4d03c35",
			"chat:0": "7aab372677ca8ad16bd81e7027ff0a5118b53f7ad632f84855caf95ab961bf20",
			"chat:1": "c2f432fed3ebfb00435f2162771448e3fd12d9c2de2ce0ec78cef63483c8ff73",
		},
	},
	{
		preset: "claude-opus-4-5",
		source: "037918157",
		hashes: {
			"terminal:0": "7da076e3bf1d3860d5de77588d98b859569884e0914cba49e2bf041691765649",
			"terminal:1": "2fdf9212c25e2cd3dee1258a9cb061a1a9194de07b05afd935743909b363a854",
			"app:0": "955bc12eef68abb57ba3e6205d1d51acc1609d476d899ea9c67f99003bfeea37",
			"app:1": "16e3e62b71e165ee2c63bbdc2ba0af18336924a0c5bc75f4c057981efd2bdbc9",
			"chat:0": "17db2cee739329d477c639a73484344fd7ca0407cf9f96afb29683fd6a56fa36",
			"chat:1": "6b9848e328d6cf0ad3da72fe9f1e51af2db094c9006d00b425e675bdcef7e58c",
		},
	},
	{
		preset: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "1a3d166512ed3772a6e9becdcf9d80a2ddad6829a95a0b8d07f48f49e8f314bd",
			"terminal:1": "8bded834f212c51a08ed58f803d2ce715831922a909251efc717d6e71fbb282c",
			"app:0": "30ae9236f16f72f1102df36c89a571f29860bf26c660860d17f0e00eeb449c13",
			"app:1": "9ad6f59475c79daf9bf31ebcacb524ce4e2481983e5ad9cebd6db0f9d44a7c2d",
			"chat:0": "cd12b888362b807fedadac2453b0c1ed570da9b9a354d73f4671c011ffed34be",
			"chat:1": "4971309e80c6575b24cf03b29a3891572ea253365c4ac4d167e6c1934eef206b",
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
			"eval-true": "f2006207f8557d06608ea89f0f6e76ba8748dc565a6e454043f95d6cb1ab9c33",
			"app-eval-true": "ec2998aaf2c5f927b96bce29c72597d85627d082972901d7b520af0ed60da0fa",
			"search-eval-true": "8442ab3a26809625fd6fdd8306b3380b6b60b7d44f54673e5dc76d2823a5b9d9",
		},
	},
	{
		modelId: "claude-fable-5.1",
		source: "037918157",
		hashes: {
			"eval-false": "10d9a2c744ce4e3a0c800775f1f480ae050b78d9d53f28ca6728c97d34539e11",
			"eval-true": "eeafd7b0295730ea42acbae4244554097c12e48b883786c727db668ad60051c4",
			"app-eval-true": "e900e0a20ad5d7717d7b2a69856c38103f09ce4da389616ec68a2c1f1bad91a3",
			"search-eval-true": "593ac47d60426a82b402e62d2621c5cf13d02a13fa4ead79f968ab9b6ce92379",
		},
	},
	{
		modelId: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"eval-false": "2628117c32a176d9d1a883cbc253c0f2031054f4b8a25392ad4756f014c9d131",
			"eval-true": "7ed8ebdb5bd82aa499dfad5dfe0888fd08947857483245baa465cd08a0ff6f35",
			"app-eval-true": "cabc37ee8e6268fcc48796b6027b1a24856ab6856c5480595c00ecb5d6e0a8ca",
			"search-eval-true": "429b25a2b1e7e05c81540151b8bf9801eb8641625523d8127f229d328eff73fa",
		},
	},
	{
		modelId: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"eval-false": "432b8496bcd913d4716f01ce68d5c567f7cc68ccf2aa3e96bc1388e56633b23d",
			"eval-true": "cc0e57d813b232f35c43811913f434564dca88cbf8f6fb78c533b14468d3e3ea",
			"app-eval-true": "1b5c4455d6091ec2851ed4d64e04ce85e1e9317b4e2e8fed1aafbb8180fe09e3",
			"search-eval-true": "1c65c4134f5d2dc03667c03d042a720396ecdb21539cd3dc692a411ddd3fe4f5",
		},
	},
	{
		modelId: "gpt-6-astra",
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
});
