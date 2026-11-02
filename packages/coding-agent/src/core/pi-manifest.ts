import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface PiManifest {
	/** The package is part of the harness; command-line packages with this flag resolve to the `system` scope. */
	system?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	hooks?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes", "hooks"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg) || !isObject(pkg.pi)) {
			return null;
		}

		const manifest: PiManifest = {};
		if (typeof pkg.pi.system === "boolean") {
			manifest.system = pkg.pi.system;
		}
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.pi[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
