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
			"terminal:1": "bdc223b2cc4a92756e3403d507d4d8f93a3b52508032fdb80d73033c92f1605a",
			"app:0": "d085ff0a62ccba956b848d1b0ebc8dc9ef568648a89446963d323ca34f3e0334",
			"app:1": "abda186687d73a51d613e6eab3d40c59d69a7d8ea26b302acc836baa32849104",
			"chat:0": "2637c07bcdd9814af8eb611ad29560ab055e4104d25a215b11ca0b3da6e28c7a",
			"chat:1": "64eac9c696d35c5e9f0c64fcf26878db4d647919bdf2941a14c57bd7a2ae8e48",
		},
	},
	{
		preset: "claude-fable-5-1",
		source: "037918157",
		hashes: {
			"terminal:0": "96282d059933bc36d5c85b21a0c75e74e24cc8df5f4688045df1b3a7859e7e03",
			"terminal:1": "d98453cb65282766dc14f8a01a05602f0a48890315d91fd7a1c068895fe5b326",
			"app:0": "dbcf76d53a9ec5101763a9f7767ac0366ed84abc7f16b95af4e312b5d5af1adc",
			"app:1": "8e5167034db41e3a50146ae1b70830c5d9cecb220e845005b5f0aca60dd3d618",
			"chat:0": "8cabbaf8f8eee4dad6693b42c68c1a27cceecc06155e7db8957e07c00d5f747d",
			"chat:1": "c07e2e6adcc21e8ec4625b25ce8d2d91ac489636d0e029996b50707fffa06a0c",
		},
	},
	{
		preset: "claude-fable-5-2",
		source: "037918157",
		hashes: {
			"terminal:0": "dafa97044d82012af3ffb5fdb33a651c290cea7c7c09adf1f7f72bae3ec71120",
			"terminal:1": "d767b259f97ea40468bd01bb9d7aa9bb707968488f31ad03a820c54a4e8a2a5a",
			"app:0": "b94983534cd8cd8f086670f96a0fac69e426fc5a5338f52ef4be225e7e1f0cb9",
			"app:1": "543fac4edc05796cfc44f13dd57ed2df11797816fdd7ddadecb9c2ddb18e1664",
			"chat:0": "25ace3ce46102dadfa5225ad60d9088b818d6a5e8e7fac7fca17ca261a0132a7",
			"chat:1": "db47d5125875b118ebe36e4b32d206666caffb4d016ff743b6a93b2e81a2cfcd",
		},
	},
	{
		preset: "claude-opus-5-5",
		source: "037918157",
		hashes: {
			"terminal:0": "884982e11fe331736b2b55f202825f26f270405371c845888307ecc2c0d8a771",
			"terminal:1": "e5c004a7c2b993cdb6494f764b062940e3a2744c9eed982ff0b2670ec7bf8315",
			"app:0": "b8b0be00f34850de4f31d876f2e539057e9e93095e712c54fbe0a7493532d9ea",
			"app:1": "bcae5dbc8d17ca370839b4502deda942d571771b1addf0c003da26350efe3da7",
			"chat:0": "6d19fb22cf2a15dbc2c8f41532abd264fdfa8d3320b26a0c2f157093630816c7",
			"chat:1": "8fd22de7a8c4402af30c6e225b863e5d7077bc70dff6424055ce09d03cc48bd4",
		},
	},
	{
		preset: "claude-opus-5",
		source: "037918157",
		hashes: {
			"terminal:0": "665439c8e4f153fcaab719eaf958994c38a6178ca1c17f22c6ef7208da31e508",
			"terminal:1": "3961e3ec63f7ef613f8e466b85f1e6eee9d2bb015a9d7857435328dc26b15f05",
			"app:0": "da91a3c16be9a9f476ace87ad957c073d3ad8edd550072a2969c833d0b10e995",
			"app:1": "bc4df8faa441abf73665dfa31ac6fc84b4e5c28309508a423713c2f24ed0cbdd",
			"chat:0": "b5aad9b56a99c9428bf244e3ed0f8fdc095ecb8fb041dc7dce1dd72e06f59b32",
			"chat:1": "846c9d89373caac55890913487a9edce1097c65664d2700c42595f7a32a2b75a",
		},
	},
	{
		preset: "claude-opus-4-8",
		source: "037918157",
		hashes: {
			"terminal:0": "99c51bc4db60395f9f3440f8aedc3f0bf333a6054c61a847b97266f5d6467d00",
			"terminal:1": "af212465b716d4484f4eeca7890f055fdabbb298e1c1e477e30cd8856506cf83",
			"app:0": "e07440b833f35c07c5100cd3d0968915e74a3472767d3972aa9fcc7b19dd361d",
			"app:1": "9385124ecbca43a275d3987f95cff70d0894e106336edeba30349c0ab5709579",
			"chat:0": "02263b1fb37e77a04abfd99fd83fe66a9fd2362430a6348de1dab3539596e98f",
			"chat:1": "f3deb54f201a3d78f48d4e91be27037e3e1e54f7efd8ae402e5b9d72c8bd10ae",
		},
	},
	{
		preset: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"terminal:0": "c31936ab02b3cccdc33f2844faa693217d11bae3a6cc1216cd42475303f4577b",
			"terminal:1": "cdb3799f686b18e48665f481c979392680d3c9ad2bdad3753d6496d099b14130",
			"app:0": "3859ca19e904eccfa1e791b0e8a98d8fabbd239e7d5f0e4697b0ced1f3bacd61",
			"app:1": "9ca8b06c2a9c365d0a7bec7d44331b840a7de182ba9813b82aae4c5545ad89c2",
			"chat:0": "dddb97c6bcd4edd45a91df1ec114ead772339346b7f670a81e1547dc583dcae7",
			"chat:1": "32561f2e26af7471ae9ba88b3d81a0e17c8f31ba2090d8cdcce3f1a7c702b01d",
		},
	},
	{
		preset: "claude-opus-4-6",
		source: "037918157",
		hashes: {
			"terminal:0": "919681cfa3e9ba48640160d4fd32990e735a519dfecdc3964175ccf689525c7c",
			"terminal:1": "1f45ad5e409ac8ea871730bac360f4904ad1bd0f8b0a5259f58ee6b695e3b587",
			"app:0": "d4ae533f21138fafe2f43171814962869ab954e37f6642fcf2474b1797cfd325",
			"app:1": "da8284ba73b4e16288bb470b75365bbc8c24068219a624c0f7e26787fd37fb41",
			"chat:0": "7aab372677ca8ad16bd81e7027ff0a5118b53f7ad632f84855caf95ab961bf20",
			"chat:1": "f7c3911623941c36379b08226cb560be58b5577449e0efe510815bef0b97646f",
		},
	},
	{
		preset: "claude-opus-4-5",
		source: "037918157",
		hashes: {
			"terminal:0": "7da076e3bf1d3860d5de77588d98b859569884e0914cba49e2bf041691765649",
			"terminal:1": "65948f74a31d0bd4d4147f0f0955df5229b83d4f12e3cd56ab517c645607b958",
			"app:0": "955bc12eef68abb57ba3e6205d1d51acc1609d476d899ea9c67f99003bfeea37",
			"app:1": "de863552eb1aa853e0ef5d3fb9a400afdc6260470a41eefb837e5096fda12720",
			"chat:0": "17db2cee739329d477c639a73484344fd7ca0407cf9f96afb29683fd6a56fa36",
			"chat:1": "cb6d6c71dadb1d1d636268ef77ecc70ead6f85d31e1094ca84a7e2485ba292c1",
		},
	},
	{
		preset: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "1a3d166512ed3772a6e9becdcf9d80a2ddad6829a95a0b8d07f48f49e8f314bd",
			"terminal:1": "4b688396589fc161890c17b2d9cf67ef9bb39e2569d5bcc51725172588e5e610",
			"app:0": "30ae9236f16f72f1102df36c89a571f29860bf26c660860d17f0e00eeb449c13",
			"app:1": "a9fd0bac4df670ed6f8ed449d18611f54e76b8c1ab60f77c15f67bcbde3c5a0a",
			"chat:0": "cd12b888362b807fedadac2453b0c1ed570da9b9a354d73f4671c011ffed34be",
			"chat:1": "be1116938c0d923e8ba4f7108918a06fe1a096146fdc50645fd6266cd7fe12a2",
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
			"eval-true": "7f8adb21f44ae95bb81712eec17cdc1caa2576d496a93e90f04982c8cdebb069",
			"app-eval-true": "9c38c63cb86addff8374ae75aa748b4a0adc96cb21621359974930f0e785dda2",
			"search-eval-true": "602e77bdc401382e540da0b3cba5bdaf1b304f583d9fd385b603dd14b1a51385",
		},
	},
	{
		modelId: "claude-fable-5.1",
		source: "037918157",
		hashes: {
			"eval-false": "10d9a2c744ce4e3a0c800775f1f480ae050b78d9d53f28ca6728c97d34539e11",
			"eval-true": "991d1e6ec1d9c99725f6147496f790d4cf854c6c67147cabcef701a368dbfde8",
			"app-eval-true": "a06d3eb4fc44bc3b14465ca721821c57f23c1bb2ee31cad4f0e6687d68c2ebb5",
			"search-eval-true": "7a583f88ece08de79e913996c56bad445a5663c3f71336fc1fa6d13f81e05479",
		},
	},
	{
		modelId: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"eval-false": "2628117c32a176d9d1a883cbc253c0f2031054f4b8a25392ad4756f014c9d131",
			"eval-true": "6020ed36e54a8e4087be7e920f3f59ea72f156ead40eda0962b2f9bfb3c2b72b",
			"app-eval-true": "c16409a39ad5be5f384b884e9a65bcb2b2e0bafac7677f587b90fc39128aa1a0",
			"search-eval-true": "f5d45c55704a553049ee8f523ad2dc254bcd1061243b46122e6b83ca851f054d",
		},
	},
	{
		modelId: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"eval-false": "432b8496bcd913d4716f01ce68d5c567f7cc68ccf2aa3e96bc1388e56633b23d",
			"eval-true": "f74f37eefb671e0c845c79beb7762c30810033cea4938947b87cacec1e1a1d04",
			"app-eval-true": "2cd633a0add5d335912abe21381ac4a2ba070f09f6617f8b9d87091bee92fccf",
			"search-eval-true": "6182062bb15960a4cf049300b36249233bb383a69185b4a607b40cc1b28221e7",
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
