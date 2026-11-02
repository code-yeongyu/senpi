import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** JSON-only generation reads the shipped catalogs but does not rewrite source shards. */
export function copyJsonModelGenerationFixture(destination: string): void {
	for (const entry of [
		"package.json",
		"scripts",
		"src/providers/data",
		"src/api/cloudflare.ts",
		"src/utils/provider-env.ts",
		"src/utils/openai-input-cap.ts",
		"src/utils/fable55-launch.ts",
		"src/providers/opengateway-catalog.ts",
		"src/providers/radius-config.ts",
	]) {
		const target = join(destination, entry);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(packageRoot, entry), target, { recursive: true });
	}
}
