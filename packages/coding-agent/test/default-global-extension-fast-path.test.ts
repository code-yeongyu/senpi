import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

type JitiImporter = (path: string) => Promise<ExtensionFactory>;
type CreateJiti = () => { import: JitiImporter };

const jitiMock = vi.hoisted(() => ({
	createJiti: vi.fn<CreateJiti>(),
	importExtension: vi.fn<JitiImporter>(),
}));

vi.mock("jiti/static", () => ({
	createJiti: jitiMock.createJiti,
}));

describe("default global extension fast path", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(
			tmpdir(),
			`senpi-default-extension-fast-path-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		previousAgentDir = process.env.SENPI_CODING_AGENT_DIR;
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		// The bundled codemode extension is default-on and loads through jiti. Disable it via the
		// real global-settings mechanism so this fast-path test only observes jiti calls for the
		// default global shims it exercises, not the bundled extension.
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ disabledBuiltinExtensions: ["codemode"] })}\n`,
		);
		jitiMock.createJiti.mockReturnValue({ import: jitiMock.importExtension });
	});

	afterEach(() => {
		vi.clearAllMocks();
		if (previousAgentDir === undefined) {
			delete process.env.SENPI_CODING_AGENT_DIR;
		} else {
			process.env.SENPI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("loads generated default shims without jiti imports", async () => {
		jitiMock.importExtension.mockImplementation(async () => {
			return (pi: ExtensionAPI) => {
				pi.registerCommand("loaded-through-jiti", {
					handler: async () => {},
				});
			};
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		await loader.reload();

		const extensionPaths = loader.getExtensions().extensions.map((extension) => extension.path);
		expect(extensionPaths).toContain(join(agentDir, "extensions", "diff.js"));
		expect(extensionPaths).toContain(join(agentDir, "extensions", "files.js"));
		expect(extensionPaths).toContain(join(agentDir, "extensions", "prompt-url-widget.js"));
		expect(extensionPaths).toContain(join(agentDir, "extensions", "tps.js"));
		expect(jitiMock.createJiti).not.toHaveBeenCalled();
		expect(jitiMock.importExtension).not.toHaveBeenCalled();
	});

	it("keeps user-modified default shim files on the normal jiti path", async () => {
		const customShimPath = join(agentDir, "extensions", "diff.js");
		writeFileSync(
			customShimPath,
			`export default function(pi) {
	pi.registerCommand("custom-diff", {
		handler: async () => {},
	});
}`,
			"utf-8",
		);

		jitiMock.importExtension.mockImplementation(async () => {
			return (pi: ExtensionAPI) => {
				pi.registerCommand("custom-diff", {
					handler: async () => {},
				});
			};
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		await loader.reload();

		const customExtension = loader.getExtensions().extensions.find((extension) => extension.path === customShimPath);
		expect(customExtension?.commands.has("custom-diff")).toBe(true);
		expect(jitiMock.createJiti).toHaveBeenCalledTimes(1);
		expect(jitiMock.importExtension).toHaveBeenCalledTimes(1);
		expect(jitiMock.importExtension.mock.calls[0]?.[0]).toBe(customShimPath);
	});
});
