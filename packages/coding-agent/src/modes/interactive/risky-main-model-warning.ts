import type { Model } from "@earendil-works/pi-ai";

export const RISKY_MAIN_MODEL_WARNING =
	"Not a recommended model. It can perform dangerous actions such as harming your computer and has not been tested. Please use a different model.";

const RISKY_MODEL_FAMILIES = ["minimax", "qwen"];

/** Matches the model fields shown to users on Senpi's main-model selection surfaces. */
export function isRiskyMainModel(model: Pick<Model<any>, "id" | "name" | "provider">): boolean {
	const searchableLabel = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
	return RISKY_MODEL_FAMILIES.some((family) => searchableLabel.includes(family));
}
