import type { Model } from "@earendil-works/pi-ai";

export const RISKY_MAIN_MODEL_WARNING =
	"Not a recommended model. It can perform dangerous actions such as harming your computer and has not been tested. Please use a different model.";

// A family name cannot follow a letter, digit, or combining mark, or precede a letter or combining mark.
// A version suffix may still follow.
const RISKY_MODEL_FAMILY = /(?:^|[^\p{L}\p{N}\p{M}])(?:minimax(?:ai)?|qwen)(?=$|[^\p{L}\p{M}])/iu;

/** Matches the model fields shown to users on Senpi's main-model selection surfaces. */
export function isRiskyMainModel(model: Pick<Model<any>, "id" | "name" | "provider">): boolean {
	return RISKY_MODEL_FAMILY.test(`${model.provider}/${model.id} ${model.name}`);
}
