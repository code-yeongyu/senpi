import { envValue } from "./brand.ts";
export function areExperimentalFeaturesEnabled(): boolean {
	return envValue("EXPERIMENTAL") === "1";
}
