import type { Model } from "@earendil-works/pi-ai";

export const RISKY_MAIN_MODEL_WARNING =
	"Not a recommended model. It can perform dangerous actions such as harming your computer and has not been tested. Please use a different model.";

// A family name counts only as its own word: no letter or digit before it (any script), no letter after (a version may follow).
const RISKY_MODEL_FAMILY = /(?:^|[^\p{L}\p{N}])(?:minimax(?:ai)?|qwen)(?=$|[^\p{L}])/iu;

/** Matches the model fields shown to users on Senpi's main-model selection surfaces. */
export function isRiskyMainModel(model: Pick<Model<any>, "id" | "name" | "provider">): boolean {
	return RISKY_MODEL_FAMILY.test(`${model.provider}/${model.id} ${model.name}`);
}
