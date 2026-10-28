import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared golden files under `docs/engine-socket/fixtures/` (senpi#4272, desktop RULING-68/68a): each directory is
 * produced by the real engine code through a builder in this folder and never edited by hand. A golden test compares
 * the committed bytes with the builder's output; run it with `SENPI_WRITE_RECOVERY_GOLDENS=1` to write them instead.
 */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const REGENERATE =
	"SENPI_WRITE_RECOVERY_GOLDENS=1 npx vitest run test/suite/regressions/4272-recovery-golden-pages.test.ts test/suite/regressions/4272-recovery-golden-nodes.test.ts (packages/coding-agent, senpi repository)";

export const serialize = (value: unknown): string => `${JSON.stringify(value, null, "\t")}\n`;

/** In regeneration mode writes `generated` first; then answers every file the directory holds, by name. */
export function committedGoldens(directory: string, generated: ReadonlyMap<string, string>): Map<string, string> {
	const absolute = join(PACKAGE_ROOT, directory);
	if (process.env.SENPI_WRITE_RECOVERY_GOLDENS === "1") {
		mkdirSync(absolute, { recursive: true });
		for (const [name, content] of generated) writeFileSync(join(absolute, name), content);
	}
	return new Map(
		readdirSync(absolute)
			.sort()
			.map((name) => [name, readFileSync(join(absolute, name), "utf8")]),
	);
}

export const readGolden = <T>(directory: string, name: string): T =>
	JSON.parse(readFileSync(join(PACKAGE_ROOT, directory, name), "utf8")) as T;
