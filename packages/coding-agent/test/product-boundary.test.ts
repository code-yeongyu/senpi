import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = new URL("../src/", import.meta.url);
const SOURCE_ROOT_PATH = fileURLToPath(SOURCE_ROOT);
const FORBIDDEN_PRODUCTION_TOKENS = [
	"@code-yeongyu/omo-senpi",
	"@oh-my-opencode/omo-senpi",
	"@oh-my-opencode/senpi-task",
	"runOmoLocalUpdateBeta",
	"--omo-local-update-worker",
	"omo-local-update",
	"SENPI_OMO_LOCAL_UPDATE",
	"origin/dev:packages/omo-senpi",
] as const;

function productionFiles(directory: URL): URL[] {
	const files: URL[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
		if (entry.isDirectory()) {
			files.push(...productionFiles(path));
		} else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
			files.push(path);
		}
	}
	return files;
}

describe("Senpi product boundary", () => {
	it("keeps OMO package layout and update behavior out of production source", () => {
		const offenders: string[] = [];
		for (const file of productionFiles(SOURCE_ROOT)) {
			const source = readFileSync(file, "utf-8");
			for (const token of FORBIDDEN_PRODUCTION_TOKENS) {
				if (source.includes(token)) {
					offenders.push(`${relative(SOURCE_ROOT_PATH, fileURLToPath(file))} contains ${token}`);
				}
			}
		}

		expect(offenders.sort()).toEqual([]);
	});

	it("has no OMO local updater modules", () => {
		const betaDirectory = new URL("../src/beta/", import.meta.url);
		const updaterModules = existsSync(betaDirectory)
			? readdirSync(betaDirectory).filter((name) => name.startsWith("omo-local-update"))
			: [];

		expect(updaterModules).toEqual([]);
	});
});
