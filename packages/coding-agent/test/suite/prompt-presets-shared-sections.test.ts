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
// Each expected value is the sha256 of the prompt rendered at that source commit.

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
	"claude-fable-5-5",
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
			"terminal:0": "07d3317e6f5f5930c53601e391a388d6d4d1a41549ed87cf60b20f3c32e3686c",
			"terminal:1": "2932668cdd9b6bfd3d9143e4133a9546e86242e3943df3d69a8a6d822ee577ae",
			"app:0": "8b80f91b8bb2690198916401d58d5fbedbda013daf428bae616757e8d832b8e4",
			"app:1": "2919e2ba46dd9abe89fe0ae7adfee0313604a5c0dafba6e44ad9c2949bd3d7dd",
			"chat:0": "7c42c85e8dc7d29c176d52d54e8cb1b5030772fb7a89706450325931acfccb5d",
			"chat:1": "43e6d5eec765006988e904704b3445ef53b17638fd73446c6c473b9b904006d6",
		},
	},
	{
		preset: "claude-fable-5-1",
		source: "037918157",
		hashes: {
			"terminal:0": "7fe610a6f9a1edb0021012ac9233bea930190618d8923d133b4f311949a81dca",
			"terminal:1": "f36babeef92ba1c8c283b0d57ef5667a287288bd74e3c50f1559be3f0c1280a3",
			"app:0": "8b0fcb7fdb125c8a122a74dfa5402e2a94e2f91a3fc4d304a110f81cba129fb9",
			"app:1": "aa0150f320888cf6086a09e6133c70cc9d074fcd3965bc586bd416b759290252",
			"chat:0": "5634c73539008c973cc2dc58b0b0ed5dd3de3260f577d3094296931f2a6a49b4",
			"chat:1": "6d563b146d86d33fb620428f6f832a48322336d940a7d44f541674f71db46a7e",
		},
	},
	{
		preset: "claude-fable-5-5",
		source: "037918157",
		hashes: {
			"terminal:0": "7fe610a6f9a1edb0021012ac9233bea930190618d8923d133b4f311949a81dca",
			"terminal:1": "f36babeef92ba1c8c283b0d57ef5667a287288bd74e3c50f1559be3f0c1280a3",
			"app:0": "8b0fcb7fdb125c8a122a74dfa5402e2a94e2f91a3fc4d304a110f81cba129fb9",
			"app:1": "aa0150f320888cf6086a09e6133c70cc9d074fcd3965bc586bd416b759290252",
			"chat:0": "5634c73539008c973cc2dc58b0b0ed5dd3de3260f577d3094296931f2a6a49b4",
			"chat:1": "6d563b146d86d33fb620428f6f832a48322336d940a7d44f541674f71db46a7e",
		},
	},
	{
		preset: "claude-opus-5-5",
		source: "037918157",
		hashes: {
			"terminal:0": "12efa3ed7c45bc3dbb980185ee9daac419c2cb8a756167ffe11c87754efb3ce3",
			"terminal:1": "4e076d55ad7f68c0fa56389403cd107c418f953849cdafdd98dac9443f75acb8",
			"app:0": "d4569bf7feddc7ce3809b79a83fc3869f48c9252a4f6d7847a81f688c46eb25d",
			"app:1": "54f4abf29b8dd3a3cba7a2ecea84f06728d81d983bb52c67233522a42928fcf5",
			"chat:0": "825ce90789f9f77b76cfe6eddd467c667881513d583d9634c3433b7dbe25fbaa",
			"chat:1": "2bc8d98bd873db43f8bda2b8c57ccb641e4b502d2b925d9264696f18c690acd7",
		},
	},
	{
		preset: "claude-opus-5",
		source: "037918157",
		hashes: {
			"terminal:0": "1a32602df95a0b10cfe32b31548feb872f8f0e0af86e9acf9026d79ef8d8fa77",
			"terminal:1": "27f56f87214812aef419a135ac4714bd25eefc6f97a5f8cfc8ae9f14d8af409c",
			"app:0": "4617b64858b64ae3f9e990a9023774e0b85259375f17e74825cebcd0848a48ea",
			"app:1": "6319820a79d07c50704d45a6fa58beb5af94423e02d47350abad13a0ce343d1d",
			"chat:0": "4b13bc52154075bba29cf638dcdcc1536e6b0c43a543ec9f0437c3c200e05d98",
			"chat:1": "7d6d929ef2bf89b287ed8312c965fbebd6c8b642f02c7433f1fe052e55d26f7f",
		},
	},
	{
		preset: "claude-opus-4-8",
		source: "037918157",
		hashes: {
			"terminal:0": "105612f73c2bccc79f1cd1a7cd07ec13d6b2eaeaa54dfd70d73376bc8a407ffe",
			"terminal:1": "982f80f40fd1c3f84d4c51e88969fcf06aa53bc3c349ac4a3f085c37b44c8f1a",
			"app:0": "e0093e53a5c40f8c9207e501a21cb835e3b6a2d9e2fc385ed3a0d86cd59a9a12",
			"app:1": "9210e84ee9161597a631058372eb1ea8f8fd0df293d345c09df306b9802fb26c",
			"chat:0": "6e8aa5c5f774171387f41fb629ae967c4e9c535f3664b0225520538abb567bf0",
			"chat:1": "0c21758f6e5689eb0bc11ef4fa7187454670659ff27ace899764ca2cf4235a85",
		},
	},
	{
		preset: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"terminal:0": "a11c219549a1a3f6cb637f0eeb4fb26061526f14de939e1dcc1463a6ca0b933e",
			"terminal:1": "fd179aa9fb0a1e26b8a30f5c3c947753ac55339d9ce48f243f226888676e1545",
			"app:0": "5ea692469c9cfbc8966584241eaf7e6e77ec462f034237c63dff5ce88da7c317",
			"app:1": "aae262e024fcb309137ab370459ee05b3b95caa7fe7e864ee77df324729da350",
			"chat:0": "ab21b4bd35640f3e76b2d153afc9c01bd9ca77b81fa0ba2b1f6fcb60699b1e6c",
			"chat:1": "c89f344a23c335c9caf5c88a7f3942df6575a12e54c7e60defdc1a1021f7b1f1",
		},
	},
	{
		preset: "claude-opus-4-6",
		source: "037918157",
		hashes: {
			"terminal:0": "30deac8b23c7dfc7027477eda4aa03c0df377e6c72e3d13d7cfe4f3e9ca1f8ab",
			"terminal:1": "e5526fff72544c4ee77435d69893e6f398d5c0fdcea8c50bc5df9156a4852cfc",
			"app:0": "22d8dadc8fe16f352d6746ace71eee34fd258c9b917f00a3ec70b8438de36519",
			"app:1": "8518466e34bb36241fd073cc7f56f02acb344d0b8c9753b9afc1fcdaba4b1983",
			"chat:0": "a83caf4f20da583aaeb69b2990d59a42276f71c0d66585d47dae91b409a8a28d",
			"chat:1": "d8d5fecf5b9cec0b92f435720b48187f16c5bac4c23b37662f6127f03b82509d",
		},
	},
	{
		preset: "claude-opus-4-5",
		source: "037918157",
		hashes: {
			"terminal:0": "00e874a11781d68c02ea1a861ff4bb62e11fb15af63d397b37289e3974b22fb2",
			"terminal:1": "4b2cc229b611de5810195e7ae237d620abdcbb22536b80a1ebddb0d87d765674",
			"app:0": "55d724330d706463fbb071e443a4d853d1645d7cc40009ecbe8d3432985a4a5f",
			"app:1": "487d835028cda878bb97bb0c474b455ebfdfa73320ec22a47851cb357027508c",
			"chat:0": "930768ae7c0333c39c969bf679e739c09de14b8f690a53ec754e6d4b46105550",
			"chat:1": "439febd8543aaba53f47636b63b659b065e49d3d4a8acc0034cebd7b7e55406c",
		},
	},
	{
		preset: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "b46ab07db55733c38aad07983e767685e896e18f6ff138f7193c54976051e01c",
			"terminal:1": "b507e9618fccd31690826b8849d0109c8e2dd218805d37b3f13c57e897d5c2a3",
			"app:0": "8fd67d13774e995b43f0b58dd3a4e37219997224deb8998f901b08f712d6c137",
			"app:1": "2bbd754bc3bb7c77a4b70f0b89fcf14a315f8ace29794f05b5979e3ed78a29ea",
			"chat:0": "1886d420fbd0dd89124d223fc54d46fda75f1ec1c39cf065441136d34976ab70",
			"chat:1": "4d43d8e8910a2a1726c8ff9960b741f6011bd43a53721d98de5ccf7386bf6aa3",
		},
	},
	{
		preset: "gpt-6-astra",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "12e87bf9658fa3777c110a783bb944c7dbd6a05f890bb83fd38c27d4766c223c",
			"terminal:1": "f2d151ae5a00b4410e1ec497980d27dced090262367351ab4ac4d1cd7d1a640a",
			"app:0": "211efa98db41d8a0cf8b590a773b53c9dfee7c324cfd234b55adaf1e05254048",
			"app:1": "390ea52b86222279cc2aaa9bb27804a3cb95e68ac5b675c65f705896681c8798",
			"chat:0": "2d4f0ba8a807a13282aa7ae1f85d16ddd99f61bce7b4294e8656b5a7b2d3995c",
			"chat:1": "b636483f5abe4949fdf5609104f46cbb06e256bb1b49ae21cbb4fa899e2b5b7c",
		},
	},
	{
		preset: "auto",
		source: "836fe1c75",
		hashes: {
			"terminal:0": "66d00340e8201da64ea5f2f36dabfa3bfdb086e1280b846793fa43b0abba805c",
			"terminal:1": "0993a7cdfcd9d794fff7a557073b828d399d6ec9389d3e51775f669598ddfab2",
			"app:0": "04005faade1a344dbfeefdd318046bde0b028be728dc8ad146c63fae81bc14c7",
			"app:1": "7b2394abc41ee65682aeef0db97b068cbb1e3dfa890be3e8817922cef5229069",
			"chat:0": "7bab76406b61bb1639b2ac868a6b52d3acb622bb17aa2720380c335563fe2d63",
			"chat:1": "d98b802b8cd918240b11ff7789ed5788ebf087ceec01569d11d7dba9bf93018d",
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
			"eval-false": "6062c59ca33d4a86c569e4c5ddae72b2ca8cd9c333b436cc16159cbd8e8434b3",
			"eval-true": "af018bca45e3929c2569ad614af7360c0851fe459e5a839f4482618903ddfcac",
			"app-eval-true": "872fa2668a1b72431c3f0778621cc10600e61c9bbbef7f1e1b1f5cd1b8302fc8",
			"search-eval-true": "49a44daf4b2f0c229872d0bd35ae9519e27cfb92c365fa3210941eaa724a04f0",
		},
	},
	{
		modelId: "claude-fable-5.1",
		source: "037918157",
		hashes: {
			"eval-false": "a0a79952bb4d6f747f5b231911f33cd193a07d0eb1022033f3e9c940ac4f7a7d",
			"eval-true": "738189bb3b74c5d2a45ace1724980764fce4cba5b23b3edda142036e1a326352",
			"app-eval-true": "82601ac62d76c2b689f8a6574cffc6a6f6af2fdef73285c425f17ca636e36825",
			"search-eval-true": "00127b732e440a7fe8028a05a8477c23db1600724e4c0d0856bca95f38bf23e8",
		},
	},
	{
		modelId: "claude-opus-4-7",
		source: "037918157",
		hashes: {
			"eval-false": "b48623ebb212503a494318888bdb5c5829dc907a5557eb8f5bdf037f87f824a5",
			"eval-true": "1531bf645c0f9e853923791abc6da9a35de80770f80913e83cfd54aa563b6a91",
			"app-eval-true": "95f3bb6a3a03eccf8454e25dce3f36a4c29bafe4e4735eaa21c3dc89424ba98f",
			"search-eval-true": "b68de6ed312c6cc7162202d5dd58a1b72269b8a569c708c5dcb2da73ac484e44",
		},
	},
	{
		modelId: "glm-5.3",
		source: "836fe1c75",
		hashes: {
			"eval-false": "201f967dc44791eea0596072424e8fbba75fd6a794ba0430835f40fbe293289e",
			"eval-true": "3ceecc57222f385e68527aa7cc27da3d7c5757d430312c63aa4945da2410c938",
			"app-eval-true": "8eaba4c75dace00fb49fa77af919960f34176cdb0215932d452899e8beab7da5",
			"search-eval-true": "c7c1ad7743eb68a48f9e97ab5bff78209020e2e773f582cf9351c05e563ce610",
		},
	},
	{
		modelId: "gpt-6-astra",
		source: "836fe1c75",
		hashes: {
			"eval-false": "52399513676af2f1c8a187a56e57cfb6303d8c4fc988393ea566b1ccfcbee368",
			"eval-true": "6654273ac44099bb2328a066193f6fee89b5daa2e9fb62dc4a5db965fd879126",
			"app-eval-true": "53bd94c6f8e526fda13d8a8dc4d014dc1d974c7f81204e294efcfe902a63bce4",
			"app-eval-false": "ee757a513e4f17629dff6e768f1ad86fd369c4488e680402818a6931eee1a732",
			"search-eval-true": "d321cea5718faec3030d1bfc2991998c341f3e69c122947242cea3e59c49be70",
			"nativebash-eval-false": "52399513676af2f1c8a187a56e57cfb6303d8c4fc988393ea566b1ccfcbee368",
			"nativebash-eval-true": "6654273ac44099bb2328a066193f6fee89b5daa2e9fb62dc4a5db965fd879126",
		},
	},
	{
		modelId: "test-default-model",
		source: "836fe1c75",
		hashes: {
			"eval-false": "a10e1b0b04d245727a685002b443dee4830986f44a103f4e796ec83ede248537",
			"eval-true": "099df65375783d192416434ba54c46e1b074b3a27d214cb9ddb271097783d623",
			"app-eval-true": "0c152593a23af17fa90558f8c3ec966c01b042ab6f4637d31ff46f8747856bbf",
			"search-eval-true": "917340703093cd0a38f3d3c642f1482c0ac2ecafdca78b008cac385fc6ce7fbe",
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
