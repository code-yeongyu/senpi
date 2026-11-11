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
			"terminal:0": "44d309a87eca5ac4845dfc6969472ea7db40d6614b5a55dad4bea6cac5f0a466",
			"terminal:1": "f080bc5a87565e8b3a07557884eeca79d72fbb8e4d29787038dd9b752a10c5d9",
			"app:0": "a1c9dd412913daebda819cadc0eec6299a2dde52c7879ca82aceb8d2a2ddbb36",
			"app:1": "611813cdfc669a6421ccf338f96102f0dcfc5cd60e8a4c20fe13e76e7d4205fa",
			"chat:0": "1e78929f97d9a7e6f6206d7b1005e774b903a5179db44aecedac269a6656f58d",
			"chat:1": "9a6c1c7969545c960a5fb62186fcf3551c7579fe7fc85790a20506858913406e",
		},
	},
	{
		preset: "claude-opus-5-5",
		source: "037918157",
		hashes: {
			"terminal:0": "9873598f396cf47952cfd3f20920d595790b05aa4be913d7c1687e098196766d",
			"terminal:1": "014667021bf2d55b838eaf7d1f1109171df0dda91d255235b36da170c1c91f0b",
			"app:0": "6f64c7c545b189f29c8f9ceb5f515a360c443ef14f2fb0fb810a03c99ad1888c",
			"app:1": "5a3d912a58dad79397e6c401fe5597b7e89669ae383c8d48c321051ceb4d3ef6",
			"chat:0": "8ce54b95172a79f99dd824fba74bbdfd64078d792d83658a63dd60f0a155605d",
			"chat:1": "d2a3a0c2c69a172922269bab1523f0dc902573037d5e33cc4bea5d6e8523d5b5",
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
			"eval-false": "a5eba7e841c76fea0adbc1cad33c922cf25d0d04f671c42694cdf80a32333064",
			"eval-true": "5e60efdc433a4b85200b94adbb3df2baa377618dfe4d97956c04b47915da6823",
			"app-eval-true": "5e3341e225de8e3590d2615fba8ddf2f0ab9efa0f5924c76fa8550cc816c0530",
			"search-eval-true": "453edac31767591c6a9dba11aa51101bc028293637eb6bdfea0e166bb636a205",
		},
	},
	{
		modelId: "claude-fable-5.1",
		source: "037918157",
		hashes: {
			"eval-false": "f36f23a19debfaee7227b7cfcd10ce356f531ed1078938e938f715ab7ecf1efc",
			"eval-true": "0e82877d9825ca57c20724c3614a40e4580cc9b29389332960b1ec6dcbd47fcf",
			"app-eval-true": "71ab9ed325c0e890c56f5f5c5738ba2d518e63b7f83e7712fe33b11491e2a712",
			"search-eval-true": "02bca1402fb43e804cc7b00a13966129bf1eef681cda89f29c0ee6f1ac1953dc",
		},
	},
	{
		modelId: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"eval-false": "e5925ed29858efede1fb627f567a18594116e9b9137ace2ac5eaa30745775f9f",
			"eval-true": "3d264326ec9c2e1a56ab4d0542b70e31da6bc103e68d14b27b89e302ffdc56e5",
			"app-eval-true": "b7c5445ec7c89b0f1d0a21078d9cd6ec747fef1e115cceb2edfc8e1462e1319e",
			"search-eval-true": "59d8095be1ef906aaa7965cbaf9810f4250b4e0bacc4d0ccc1c9616b279e207b",
		},
	},
	{
		modelId: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"eval-false": "f16d61667a75c9a3d38518a4e1a2be9a8ae3d10ded916a5e44256c251dd6a2ba",
			"eval-true": "3fa092c1adbb969cace26a0ee8b406a61884d42b4c8785a69c7a5d16f6679466",
			"app-eval-true": "489e8fe9d149eeddd45cd4a7bc9a2aa008b04b54fb4aac8877477daa647ad027",
			"search-eval-true": "6644dcca19f00d2afcd89286328592fb455e5abbc118f084179301f5e88a3c6a",
		},
	},
	{
		modelId: "gpt-6-astra",
		source: "836fe1c75",
		hashes: {
			"eval-false": "3f526b2049643f0bdb894ffeae6bbb7e476a6bee251603cad0c80e9893e434e4",
			"eval-true": "9c9caad4e47ae60f24a6a078704898ffce9fcb40e0bd5c7c6fa7bd1e34b2de14",
			"app-eval-true": "d095e4f48ed03cb317105a98161d50991edbbeaa003669f407c0af67261a2af4",
			"app-eval-false": "22a1d9aa37afb4b6d2762491fb6b9ad0747a25bdca2a5aac6329aaa61c2a537f",
			"search-eval-true": "000696e1244fbd570f480a023e000dc3f50ee4c6d50e982a306c8eac2042e96b",
			"nativebash-eval-false": "3f526b2049643f0bdb894ffeae6bbb7e476a6bee251603cad0c80e9893e434e4",
			"nativebash-eval-true": "9c9caad4e47ae60f24a6a078704898ffce9fcb40e0bd5c7c6fa7bd1e34b2de14",
		},
	},
	{
		modelId: "test-default-model",
		source: "836fe1c75",
		hashes: {
			"eval-false": "a5ffbb2ac532a69c22037d15ddad0889b8381ba5958f89599d6790987b002cfb",
			"eval-true": "24182221b1dca8f25c81cba678c0a221c045c108733c1b7d0180a9c7639e8d57",
			"app-eval-true": "20c02aaa574880e5ee69b812ad8d99dc7873fc63f94e476f348bb3c56150c205",
			"search-eval-true": "2b01a9e76a7ece5fba20533ed57956a46a30164a2fa93bc28fd1571cad0ea5bb",
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
