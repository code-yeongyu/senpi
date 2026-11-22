import type { Model } from "@earendil-works/pi-ai";

export const RISKY_MAIN_MODEL_WARNING =
	"Not a recommended model. It can perform dangerous actions such as harming your computer and has not been tested. Please use a different model.";

const RISKY_MODEL_FAMILY = /(?:^|[^a-z0-9])(?:minimax(?:ai)?|qwen)(?=$|[^a-z])/i;

/** Matches the model fields shown to users on Senpi's main-model selection surfaces. */
export function isRiskyMainModel(model: Pick<Model<any>, "id" | "name" | "provider">): boolean {
	return RISKY_MODEL_FAMILY.test(`${model.provider}/${model.id} ${model.name}`);
}
