import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CODING_AGENT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REPOSITORY_ROOT = resolve(CODING_AGENT_ROOT, "../..");
const CODEMODE_ENTRY = resolve(CODING_AGENT_ROOT, "..", "senpi-codemode", "src", "index.ts");
const CODEMODE_PACKAGE_NAME = "@code-yeongyu/senpi-codemode";

type ProbeResult = {
	errors: Array<{ path: string; error: string }>;
	evalExtensions: Array<{
		path: string;
		sourceInfo: { source: string; scope: string; origin: string };
		evalSourceInfo: { source: string; scope: string; origin: string } | undefined;
		description: string | undefined;
		sessionStartHandlers: number;
	}>;
	sessionStartRefreshes: number;
};

describe("bundled codemode identity and precedence", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = join(tmpdir(), `senpi-codemode-builtin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function runProbe(settings: Record<string, unknown>): ProbeResult {
		const probePath = join(root, "codemode-builtin-probe.mts");
		const resourceLoaderUrl = pathToFileURL(join(CODING_AGENT_ROOT, "src", "core", "resource-loader.ts")).href;
		const sessionManagerUrl = pathToFileURL(join(CODING_AGENT_ROOT, "src", "core", "session-manager.ts")).href;
		writeFileSync(
			probePath,
			`import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from ${JSON.stringify(resourceLoaderUrl)};
import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};

const [agentDir, cwd] = process.argv.slice(2);
const artifactDirsBefore = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("senpi-codemode-")));
const loader = new DefaultResourceLoader({
	cwd,
	agentDir,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();
const result = loader.getExtensions();
const evalExtensions = result.extensions.filter((extension) => extension.tools.has("eval"));
let sessionStartRefreshes = 0;
const evalExtension = evalExtensions[0];
if (evalExtension) {
	result.runtime.getActiveTools = () => [];
	result.runtime.executeTool = async () => ({ content: [], details: {} });
	result.runtime.refreshTools = () => {
		sessionStartRefreshes += 1;
	};
	const sessionStart = evalExtension.handlers.get("session_start")?.[0];
	if (sessionStart) {
		await sessionStart({ type: "session_start", reason: "startup" }, { cwd, sessionManager: SessionManager.inMemory(), model: undefined });
	}
	const sessionShutdown = evalExtension.handlers.get("session_shutdown")?.[0];
	if (sessionShutdown) {
		await sessionShutdown({ type: "session_shutdown", reason: "exit" }, {});
	}
}
for (const entry of readdirSync(tmpdir())) {
	if (entry.startsWith("senpi-codemode-") && !artifactDirsBefore.has(entry)) {
		rmSync(join(tmpdir(), entry), { recursive: true, force: true });
	}
}
process.stdout.write(JSON.stringify({
	errors: result.errors,
	evalExtensions: evalExtensions.map((extension) => ({
		path: extension.path,
		sourceInfo: extension.sourceInfo,
		evalSourceInfo: extension.tools.get("eval")?.sourceInfo,
		description: extension.tools.get("eval")?.definition.description,
		sessionStartHandlers: extension.handlers.get("session_start")?.length ?? 0,
	})),
	sessionStartRefreshes,
}));
`,
		);
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings)}\n`);
		const output = execFileSync(process.execPath, ["--import", "tsx", probePath, agentDir, cwd], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: root,
				SENPI_CODEMODE_PY: "0",
				SENPI_CODEMODE_JS: "1",
				SENPI_CODEMODE_RB: "0",
				SENPI_CODEMODE_JL: "0",
			},
		});
		return JSON.parse(output) as ProbeResult;
	}

	it("registers eval at session start from the default bundled package path", () => {
		const result = runProbe({ enabledBuiltinExtensions: ["codemode"] });

		expect(result.errors).toEqual([]);
		expect(result.evalExtensions).toHaveLength(1);
		expect(result.evalExtensions[0]).toMatchObject({
			path: CODEMODE_ENTRY,
			sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
			evalSourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
			description: expect.any(String),
			sessionStartHandlers: 1,
		});
		expect(result.sessionStartRefreshes).toBe(1);
	}, 30_000);

	it("keeps exactly one eval registration when the npm package is configured by the user", () => {
		const userPackageDir = join(agentDir, "npm", "node_modules", "@code-yeongyu", "senpi-codemode");
		mkdirSync(userPackageDir, { recursive: true });
		writeFileSync(
			join(userPackageDir, "package.json"),
			JSON.stringify({ name: CODEMODE_PACKAGE_NAME, version: "2026.7.26", pi: { extensions: ["./index.ts"] } }),
		);
		writeFileSync(
			join(userPackageDir, "index.ts"),
			`import { Type } from "typebox";
export default function(pi) {
	pi.registerTool({
		name: "eval",
		description: "user configured codemode",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	});
}
`,
		);

		const result = runProbe({
			enabledBuiltinExtensions: ["codemode"],
			packages: [`npm:${CODEMODE_PACKAGE_NAME}@2026.7.26`],
		});

		expect(result.errors).toEqual([]);
		expect(result.evalExtensions).toHaveLength(1);
		expect(result.evalExtensions[0]).toMatchObject({
			path: CODEMODE_ENTRY,
			sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
			evalSourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
		});
		expect(result.evalExtensions[0]?.description).not.toBe("user configured codemode");
	}, 30_000);
});
