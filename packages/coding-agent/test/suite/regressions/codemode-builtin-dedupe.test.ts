import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

const CODEMODE_ENTRY = resolve(process.cwd(), "..", "senpi-codemode", "src", "index.ts");
const CODEMODE_PACKAGE_NAME = "@code-yeongyu/senpi-codemode";

type ProbeResult = {
	errors: Array<{ path: string; error: string }>;
	evalExtensions: Array<{
		path: string;
		sourceInfo: { source: string; scope: string; origin: string };
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
		vi.stubEnv("HOME", root);
		vi.stubEnv("SENPI_CODEMODE_PY", "0");
		vi.stubEnv("SENPI_CODEMODE_JS", "1");
		vi.stubEnv("SENPI_CODEMODE_RB", "0");
		vi.stubEnv("SENPI_CODEMODE_JL", "0");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function runProbe(settings: Record<string, unknown>): Promise<ProbeResult> {
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings)}\n`);
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
			result.runtime.executeTool = async () => {
				throw new Error("Unexpected tool execution during registration");
			};
			result.runtime.refreshTools = () => {
				sessionStartRefreshes += 1;
			};
			const ctx: Partial<ExtensionContext> = {
				cwd,
				// Keep artifacts under this test's root rather than sweeping the shared temp directory.
				sessionManager: SessionManager.create(cwd, join(root, "sessions")),
				model: undefined,
			};
			try {
				await evalExtension.handlers.get("session_start")?.[0]?.(
					{ type: "session_start" },
					ctx as ExtensionContext,
				);
			} finally {
				await evalExtension.handlers.get("session_shutdown")?.[0]?.(
					{ type: "session_shutdown" },
					ctx as ExtensionContext,
				);
			}
		}
		return {
			errors: result.errors,
			evalExtensions: evalExtensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
				description: extension.tools.get("eval")?.definition.description,
				sessionStartHandlers: extension.handlers.get("session_start")?.length ?? 0,
			})),
			sessionStartRefreshes,
		};
	}

	// #4798: exercise the real loader and lifecycle without cold-booting another interpreter per case.
	it("registers eval at session start from the default bundled package path", async () => {
		const result = await runProbe({ enabledBuiltinExtensions: ["codemode"] });

		expect(result.errors).toEqual([]);
		expect(result.evalExtensions).toHaveLength(1);
		expect(result.evalExtensions[0]).toMatchObject({
			path: CODEMODE_ENTRY,
			sourceInfo: { source: "builtin", scope: "system", origin: "top-level" },
			description: expect.any(String),
			sessionStartHandlers: 1,
		});
		expect(result.sessionStartRefreshes).toBe(1);
	});

	it("keeps exactly one eval registration when the npm package is configured by the user", async () => {
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

		const result = await runProbe({
			enabledBuiltinExtensions: ["codemode"],
			packages: [`npm:${CODEMODE_PACKAGE_NAME}@2026.7.26`],
		});

		expect(result.errors).toEqual([]);
		expect(result.evalExtensions).toHaveLength(1);
		expect(result.evalExtensions[0]).toMatchObject({
			path: CODEMODE_ENTRY,
			sourceInfo: { source: "builtin", scope: "system", origin: "top-level" },
		});
		expect(result.evalExtensions[0]?.description).not.toBe("user configured codemode");
	});
});
