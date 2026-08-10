import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = new URL("../../../", import.meta.url);
const REPOSITORY_ROOT_PATH = fileURLToPath(REPOSITORY_ROOT);
const FORBIDDEN_PRODUCTION_TOKENS = [
	"@code-yeongyu/omo-",
	"@oh-my-opencode/",
	"oh-my-openagent",
	"oh-my-opencode",
	"omo-ai",
	"runOmoLocalUpdateBeta",
	"--omo-local-update-worker",
	"omo-local-update",
	"SENPI_OMO_LOCAL_UPDATE",
	"origin/dev:packages/omo-senpi",
	"detectOmoNativeInstall",
	"isOmoNative",
	"setOmoNative",
	"omo-native-detect",
	"OmO Native",
	"omo-desktop-app",
	".omo/plans",
	".omo/drafts",
	".omo/ulw-research",
	"~/.omo/omo.jsonc",
	"/local-workspaces/omo/",
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
function productionSourceRoots(): URL[] {
	const roots: URL[] = [];
	for (const containerName of ["packages", "crates"]) {
		const container = new URL(`${containerName}/`, REPOSITORY_ROOT);
		if (!existsSync(container)) continue;
		for (const entry of readdirSync(container, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const sourceRoot = new URL(`${entry.name}/src/`, container);
			if (existsSync(sourceRoot)) roots.push(sourceRoot);
		}
	}
	return roots;
}

describe("Senpi product boundary", () => {
	it("keeps downstream product layout and behavior out of production source", () => {
		const offenders: string[] = [];
		for (const sourceRoot of productionSourceRoots()) {
			for (const file of productionFiles(sourceRoot)) {
				const source = readFileSync(file, "utf-8");
				for (const token of FORBIDDEN_PRODUCTION_TOKENS) {
					if (source.includes(token)) {
						offenders.push(`${relative(REPOSITORY_ROOT_PATH, fileURLToPath(file))} contains ${token}`);
					}
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
