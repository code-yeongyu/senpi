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
			"terminal:1": "242402e3b81e1a947e9ec62c13b60696b340975f732011a6ae0e8a00fd634fa1",
			"app:0": "d085ff0a62ccba956b848d1b0ebc8dc9ef568648a89446963d323ca34f3e0334",
			"app:1": "79797b6cd0b7c4eec04f44fdb55d7c9fe934b3fa4c1887bed4e91515b7c36771",
			"chat:0": "2637c07bcdd9814af8eb611ad29560ab055e4104d25a215b11ca0b3da6e28c7a",
			"chat:1": "361d615222736ad816a0d177d8c80612ae2541f3ad8f9f2ecbec61efd3e058b1",
		},
	},
	{
		preset: "claude-fable-5-1",
		source: "037918157",
		hashes: {
			"terminal:0": "96282d059933bc36d5c85b21a0c75e74e24cc8df5f4688045df1b3a7859e7e03",
			"terminal:1": "28bc19701bae5a8d0b660702d69af0e3cb8cccd92c0464a547cf567f0ab216f1",
			"app:0": "dbcf76d53a9ec5101763a9f7767ac0366ed84abc7f16b95af4e312b5d5af1adc",
			"app:1": "36d8d3432415ceac7a2b8898c1a6dce0ee78bcfff7ee56cf79cc158e35454799",
			"chat:0": "8cabbaf8f8eee4dad6693b42c68c1a27cceecc06155e7db8957e07c00d5f747d",
			"chat:1": "c41fbd46793bed79afbd70e08e163815f1883a12eed518e6903e854a48cb6137",
		},
	},
	{
		preset: "claude-fable-5-2",
		source: "037918157",
		hashes: {
			"terminal:0": "dafa97044d82012af3ffb5fdb33a651c290cea7c7c09adf1f7f72bae3ec71120",
			"terminal:1": "50aa19efa1e06ef9773204107f19c1a94ce42f251671c141c1c10200063db403",
			"app:0": "b94983534cd8cd8f086670f96a0fac69e426fc5a5338f52ef4be225e7e1f0cb9",
			"app:1": "e333c0701b842710ef3cfe2177c9dd5b13b6bd0703ce00b3ddf000bc318be552",
			"chat:0": "25ace3ce46102dadfa5225ad60d9088b818d6a5e8e7fac7fca17ca261a0132a7",
			"chat:1": "8a1e44a416fbc8c33ebb7735d2d9f5cbfe657b80c44ea1ec5499730660f9e5a6",
		},
	},
	{
		preset: "claude-opus-5-5",
		source: "037918157",
		hashes: {
			"terminal:0": "884982e11fe331736b2b55f202825f26f270405371c845888307ecc2c0d8a771",
			"terminal:1": "691feb892535aedb0047550f3f4a045181d29b0f5454c6027ae2d5812675f79e",
			"app:0": "b8b0be00f34850de4f31d876f2e539057e9e93095e712c54fbe0a7493532d9ea",
			"app:1": "ec4c7efcc854363e1495d9a70b2ff12bb953f458ee85e5c0a42475116787565d",
			"chat:0": "6d19fb22cf2a15dbc2c8f41532abd264fdfa8d3320b26a0c2f157093630816c7",
			"chat:1": "a7002606eaa0de3470633489137fd61517cbc17b8547eeb93cae1d9b059b81b1",
		},
	},
	{
		preset: "claude-opus-5",
		source: "037918157",
		hashes: {
			"terminal:0": "665439c8e4f153fcaab719eaf958994c38a6178ca1c17f22c6ef7208da31e508",
			"terminal:1": "35932a504c95f22d4a4c851df686b9f9724bd24fe580f1ead470981f3b5a386d",
			"app:0": "da91a3c16be9a9f476ace87ad957c073d3ad8edd550072a2969c833d0b10e995",
			"app:1": "5c6507a2d6c61c7d8bc8fbae6cbe6a617903ba8389ed1adc5a467ca442f372e3",
			"chat:0": "b5aad9b56a99c9428bf244e3ed0f8fdc095ecb8fb041dc7dce1dd72e06f59b32",
			"chat:1": "a395f25292f2a20832dda43c0331723ae0db61bedd86511275591907a616074d",
		},
	},
	{
		preset: "claude-opus-4-8",
		source: "037918157",
		hashes: {
			"terminal:0": "99c51bc4db60395f9f3440f8aedc3f0bf333a6054c61a847b97266f5d6467d00",
			"terminal:1": "37bec07187e32be8377463aea7b0750ec0ba684dbd31a836843698f9460d45da",
			"app:0": "e07440b833f35c07c5100cd3d0968915e74a3472767d3972aa9fcc7b19dd361d",
			"app:1": "907c8c1a45b27addd555e9761f9321c4879eac8673803cdc641c7b28d2ef4bc5",
			"chat:0": "02263b1fb37e77a04abfd99fd83fe66a9fd2362430a6348de1dab3539596e98f",
			"chat:1": "0fb444585bd3ca3f3b1cef49b98196bce0d8b9dda56aae2905c679fba6e1eed1",
		},
	},
	{
		preset: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"terminal:0": "c31936ab02b3cccdc33f2844faa693217d11bae3a6cc1216cd42475303f4577b",
			"terminal:1": "a3a2a7da229f8d6ee97dc65684312252575a5d0f5c5d0587177514adc0da98b9",
			"app:0": "3859ca19e904eccfa1e791b0e8a98d8fabbd239e7d5f0e4697b0ced1f3bacd61",
			"app:1": "3fee92c866535b2b6af25ce4dde13ee9b80d7a3fa3f0216d72ad84ab359f8223",
			"chat:0": "dddb97c6bcd4edd45a91df1ec114ead772339346b7f670a81e1547dc583dcae7",
			"chat:1": "e15f524efbf8882d84bbbaf9e50947eada07c08fd19fe84f05221ab90beda7c3",
		},
	},
	{
		preset: "claude-opus-4-6",
		source: "037918157",
		hashes: {
			"terminal:0": "919681cfa3e9ba48640160d4fd32990e735a519dfecdc3964175ccf689525c7c",
			"terminal:1": "9b514ab6ae6fba2e56efc52b8e4b08cac2f130b9e05f7119998976f26432e341",
			"app:0": "d4ae533f21138fafe2f43171814962869ab954e37f6642fcf2474b1797cfd325",
			"app:1": "99b95afd93765b289b09e9727dc00670c9d7d84d72fcb5f700824826647af152",
			"chat:0": "7aab372677ca8ad16bd81e7027ff0a5118b53f7ad632f84855caf95ab961bf20",
			"chat:1": "7319f5af7a1add40e5f0fd57ba1ef0b6c57bf1abf9489d608978e900cfabb28b",
		},
	},
	{
		preset: "claude-opus-4-5",
		source: "037918157",
		hashes: {
			"terminal:0": "7da076e3bf1d3860d5de77588d98b859569884e0914cba49e2bf041691765649",
			"terminal:1": "9ca97f48400b3a091b7340be4e0031afc6377fb78907f691a7ca54c95d650f22",
			"app:0": "955bc12eef68abb57ba3e6205d1d51acc1609d476d899ea9c67f99003bfeea37",
			"app:1": "86df4bb8e05b3fc7c52bce7810cdc62401650f3f4ca11a0261bb61eac74b8f47",
			"chat:0": "17db2cee739329d477c639a73484344fd7ca0407cf9f96afb29683fd6a56fa36",
			"chat:1": "48296128ce30254a03955c146dd41d18f6f852272042cd9262a2192d1d20601f",
		},
	},
	{
		preset: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "1a3d166512ed3772a6e9becdcf9d80a2ddad6829a95a0b8d07f48f49e8f314bd",
			"terminal:1": "d591313d38dacfc33ea50dea7d49aef4e437f02acae315175c8b0e582c9ca8a0",
			"app:0": "30ae9236f16f72f1102df36c89a571f29860bf26c660860d17f0e00eeb449c13",
			"app:1": "9081ff75286f3b6415543a0db93c63c2719a183db1ae5e244567b97438cb1a52",
			"chat:0": "cd12b888362b807fedadac2453b0c1ed570da9b9a354d73f4671c011ffed34be",
			"chat:1": "7cec2aabbede707483212d6e5e5a57846637804d919de8f61a428793e2066cf9",
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
			"eval-true": "e91ada8faf37ba27838bc2fad518333d68462b2e4175d88dc1fc38e92f978f5d",
			"app-eval-true": "8a3b3ec7d3a82aaf9d37f4f900810902ca80351b88635dd01e089247ca8bfb3e",
			"search-eval-true": "51ec7db9f23b5060c4b73ad8c6a19ff0989c6fdb75f72363d56047407ee1438b",
		},
	},
	{
		modelId: "claude-fable-5.1",
		source: "037918157",
		hashes: {
			"eval-false": "10d9a2c744ce4e3a0c800775f1f480ae050b78d9d53f28ca6728c97d34539e11",
			"eval-true": "cb4e531d676ce3e71a6a23205aa254c4a0c4c233f007b9ba0cd0c5b1c6332a03",
			"app-eval-true": "cdc7c56e85b65b33d7f7aa919f9394b5a344ade28ce64c0d1582b25b651d2215",
			"search-eval-true": "e012586e760aea77be06e46f2c1efe7d5dcc5a50cb60492b7672cb864b5a8157",
		},
	},
	{
		modelId: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"eval-false": "2628117c32a176d9d1a883cbc253c0f2031054f4b8a25392ad4756f014c9d131",
			"eval-true": "2de2afb6602710bc5e9de6da68307ade33d130e5ca5f153671c4372f32a3338f",
			"app-eval-true": "3c154eb9ad1350586cac398aa9623af6696e3e07a70bded3c122286080fb8140",
			"search-eval-true": "ea2221160cd09b341ba0c92042f72ce91f1b67293dfae162ef7d76d2a1a958b2",
		},
	},
	{
		modelId: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"eval-false": "432b8496bcd913d4716f01ce68d5c567f7cc68ccf2aa3e96bc1388e56633b23d",
			"eval-true": "9e1d74a1311612ab2358728271c2e8933c1e12e978b04efe65440f2905cacabb",
			"app-eval-true": "3be0e27d0c155974328623bb6fbf229bba197ef826439a9016cb831764b8b7b0",
			"search-eval-true": "ee73696c02cb1fda5ccf4f269838b5f00a8587d7591d5ddf979507b18239c581",
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
