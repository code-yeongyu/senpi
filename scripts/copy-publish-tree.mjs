#!/usr/bin/env node
import { cpSync } from "node:fs";

/** Copy release assets without shipping build-time source maps, retaining any workspace filter. */
export function copyPublishTree(source, destination, options = {}) {
	cpSync(source, destination, {
		...options,
		recursive: true,
		filter: (path, target) => !path.endsWith(".map") && (options.filter?.(path, target) ?? true),
	});
}
