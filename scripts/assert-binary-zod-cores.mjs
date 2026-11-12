#!/usr/bin/env node
import { assertBinaryZodCores } from "./bundle-zod-core-guard.mjs";

// Build step of scripts/build-binaries.sh: fails the build when a compiled binary carries a stale zod (senpi#6497).
try {
	const stale = assertBinaryZodCores(process.argv.slice(2));
	console.log(`zod core scan: ${process.argv.length - 2} binary(ies) ok, ${stale.length} pinned stale copy(ies)`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
