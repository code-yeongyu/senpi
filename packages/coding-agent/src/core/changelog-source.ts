import { BRAND, getChangelogPath, VERSION } from "../config.ts";
import type { BrandProfile } from "./brand.ts";

export interface ChangelogSource {
	readonly id: string;
	readonly path: string;
	readonly version: string | undefined;
	readonly rewriteLinks: boolean;
}

function brandSource(brand: BrandProfile): ChangelogSource {
	const configured = brand.changelog;
	if (!configured) {
		return { id: brand.name.toLowerCase(), path: getChangelogPath(), version: undefined, rewriteLinks: false };
	}
	return {
		id: brand.name.toLowerCase(),
		path: configured.path,
		version: configured.version,
		rewriteLinks: false,
	};
}

export function resolveChangelogSource(): ChangelogSource {
	if (BRAND) return brandSource(BRAND);
	return { id: "engine", path: getChangelogPath(), version: VERSION, rewriteLinks: true };
}
