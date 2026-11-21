#!/usr/bin/env node
import { assertBinaryZodCores, describeStaleZodAllowances } from "./bundle-zod-core-guard.mjs";

// Build step of scripts/build-binaries.sh: fails the build when a compiled binary carries a stale zod (senpi#6497).
try {
	const result = assertBinaryZodCores(process.argv.slice(2));
	for (const line of describeStaleZodAllowances(result)) console.log(line);
	console.log(`zod core scan: ${process.argv.length - 2} binary(ies) ok, ${result.copies.length} allowed stale copy(ies)`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
