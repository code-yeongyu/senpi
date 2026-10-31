import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveConfigValue,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
} from "../../../src/core/resolve-config-value.ts";

export const SECRET = "synthetic/3858 credential?+alpha";
export const ROTATED = "synthetic/3858 credential?+beta";
export type Reference = { $file: string } | { $env: string } | { $concat: unknown[] };

export function referenceRoot() {
	// External macOS scratch volumes may have group-writable mount points.
	// Successful file-read fixtures need a secure ancestor chain independently
	// of the runtime's TMPDIR; mkdtemp creates an owner-only directory here.
	const parent = process.platform === "darwin" ? "/Users/Shared" : tmpdir();
	const root = mkdtempSync(join(parent, "config-reference-3858-"));
	return {
		root,
		file: (name: string, value: string | Uint8Array = SECRET, mode = 0o600) => {
			const path = join(root, name);
			writeFileSync(path, value, { mode });
			return path;
		},
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

export async function resolveReference(
	value: unknown,
	options: {
		root: string;
		env?: Record<string, string>;
		authority?: string;
		entry?: "cached" | "uncached" | "throwing";
	},
): Promise<unknown> {
	const context = {
		origin: join(options.root, "models.json"),
		baseDir: options.root,
		authority: options.authority ?? "trusted",
		field: "provider.apiKey",
		env: options.env ?? {},
	};
	const entry = options.entry ?? "cached";
	return entry === "throwing"
		? Reflect.apply(resolveConfigValueOrThrow, undefined, [value, "provider.apiKey", options.env, context])
		: Reflect.apply(entry === "cached" ? resolveConfigValue : resolveConfigValueUncached, undefined, [
				value,
				options.env,
				context,
			]);
}
