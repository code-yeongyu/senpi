import { pathToFileURL } from "node:url";
import { canonical, type GateReport } from "./gate-report.ts";

/** Dynamic imports here are the deliberate --target checkout boundary. */
export async function measureSurfaces(target: string): Promise<Pick<GateReport, "prompts" | "schemas">> {
	const { buildEvalPrompt }: typeof import("../src/prompt/eval-prompt.ts") = await import(
		pathToFileURL(`${target}/src/prompt/eval-prompt.ts`).href
	);
	const { createEvalInputSchema }: typeof import("../src/tool/types.ts") = await import(
		pathToFileURL(`${target}/src/tool/types.ts`).href
	);
	const prompts: GateReport["prompts"] = {};
	const schemas: GateReport["schemas"] = {};
	const models = { default: "fixture", claude: "claude-fixture", codex: "codex-fixture", gpt: "gpt-fixture", kimi: "kimi-fixture" };
	const languages = {
		js: { js: true, py: false, rb: false, jl: false },
		"js+py": { js: true, py: true, rb: false, jl: false },
		all: { js: true, py: true, rb: true, jl: true },
	};
	for (const [set, enabled] of Object.entries(languages)) {
		schemas[set] = canonical(createEvalInputSchema(enabled));
		// The sandbox field exists only with sandbox cells turned on; the cells above prove the default schema unchanged.
		schemas[`${set}+sandbox`] = canonical(createEvalInputSchema(enabled, undefined, { sandbox: true }));
		for (const [style, modelId] of Object.entries(models)) {
			for (const spawns of [false, true]) {
				for (const monitor of [false, true]) {
					for (const runtime of ["bun", "node"]) {
						for (const hostLine of [undefined, "<host-environment>"]) {
						const parts = buildEvalPrompt(enabled, {
							modelId,
							spawns,
							monitor,
							jsRuntime: { name: runtime, version: "<runtime-version>" },
							bunSkillPath: "<bun-skill-path>",
							...(hostLine === undefined ? {} : { hostLine }),
						});
						const content = [parts.description, parts.promptSnippet, ...parts.promptGuidelines].join("\n");
						prompts[`${style}/${spawns}/${monitor}/${set}/${runtime}${hostLine === undefined ? "" : "/host"}`] = {
							...parts,
							promptGuidelines: [...parts.promptGuidelines],
							bytes: Buffer.byteLength(content),
							tokens: content.length / 4,
						};
						}
					}
				}
			}
		}
	}
	return { prompts, schemas };
}
