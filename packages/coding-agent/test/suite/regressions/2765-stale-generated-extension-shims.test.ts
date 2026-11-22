import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_PREFIX } from "../../../src/config.ts";
import { GENERATED_SHIM_BANNER } from "../../../src/core/generated-shim-banner.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

/**
 * Regression #2765: a generated global-default extension shim re-exports an ABSOLUTE path into the
 * install that wrote it. After an install-method change that path is gone. The shim was never
 * repaired when the running engine had no on-disk builtin (a compiled binary), and the loader
 * imported it, so every start reported "Cannot find module".
 */
const BANNER = GENERATED_SHIM_BANNER;
const PACKAGE_DIR_ENV = `${ENV_PREFIX}_PACKAGE_DIR`;

describe("#2765 stale generated global-default extension shims", () => {
	let tempDir: string;
	let agentDir: string;
	let extensionsDir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-2765-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		for (const key of ["SENPI_CODING_AGENT_DIR", `${ENV_PREFIX}_CODING_AGENT_DIR`, PACKAGE_DIR_ENV])
			saved[key] = process.env[key];
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
		process.env[`${ENV_PREFIX}_CODING_AGENT_DIR`] = agentDir;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function deadShim(id: string): string {
		const dead = join(
			tempDir,
			"old-npm-install",
			"node_modules",
			"@code-yeongyu",
			"senpi",
			"dist",
			"core",
			"extensions",
			"builtin",
			`${id}.js`,
		);
		return `${BANNER}export { default } from ${JSON.stringify(`file://${dead}`)};\n`;
	}

	function loader(): DefaultResourceLoader {
		return new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	}

	function withoutOnDiskBuiltins(): void {
		// The engine's package dir holds no builtin modules, as in a compiled binary.
		const empty = join(tempDir, "compiled-engine");
		mkdirSync(empty, { recursive: true });
		process.env[PACKAGE_DIR_ENV] = empty;
	}

	it("#given a generated shim whose target is gone and an engine with on-disk builtins #when resources load #then the shim is rewritten to the current builtin and nothing fails", async () => {
		const shimPath = join(extensionsDir, "diff.js");
		writeFileSync(shimPath, deadShim("diff"));

		const resourceLoader = loader();
		await resourceLoader.reload();

		expect(readFileSync(shimPath, "utf-8")).not.toContain("old-npm-install");
		expect(resourceLoader.getExtensions().errors).toEqual([]);
	});

	it("#given generated shims whose targets are gone and an engine without on-disk builtins #when resources load #then they are removed and no extension load error is reported", async () => {
		withoutOnDiskBuiltins();
		for (const id of ["diff", "files", "prompt-url-widget", "tps"])
			writeFileSync(join(extensionsDir, `${id}.js`), deadShim(id));

		const resourceLoader = loader();
		await resourceLoader.reload();

		for (const id of ["diff", "files", "prompt-url-widget", "tps"])
			expect(existsSync(join(extensionsDir, `${id}.js`))).toBe(false);
		expect(resourceLoader.getExtensions().errors).toEqual([]);
	});

	it("#given a dead-target generated shim in an agent dir other than the default #when its extensions load #then the shim is skipped without a load error", async () => {
		const otherAgentDir = join(tempDir, "other-agent");
		const otherExtensions = join(otherAgentDir, "extensions");
		mkdirSync(otherExtensions, { recursive: true });
		const shimPath = join(otherExtensions, "tps.js");
		writeFileSync(shimPath, deadShim("tps"));

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: otherAgentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		expect(resourceLoader.getExtensions().errors).toEqual([]);
		expect(readFileSync(shimPath, "utf-8")).toBe(deadShim("tps"));
	});

	it("#given files that only look like a dead generated shim #when resources load without on-disk builtins #then none of them is removed", async () => {
		withoutOnDiskBuiltins();
		const edited = `${deadShim("diff")}export const mine = 1;\n`;
		const bannerLater = `// my notes\n${deadShim("files")}`;
		writeFileSync(join(extensionsDir, "diff.js"), edited);
		writeFileSync(join(extensionsDir, "files.js"), bannerLater);

		await loader().reload();

		expect(readFileSync(join(extensionsDir, "diff.js"), "utf-8")).toBe(edited);
		expect(readFileSync(join(extensionsDir, "files.js"), "utf-8")).toBe(bannerLater);
	});

	it("#given a user-authored file at a shim path #when resources load without on-disk builtins #then it is left byte-identical", async () => {
		withoutOnDiskBuiltins();
		const userPath = join(extensionsDir, "diff.js");
		const userContent = "// my own diff extension\nexport default function () {}\n";
		writeFileSync(userPath, userContent);

		await loader().reload();

		expect(readFileSync(userPath, "utf-8")).toBe(userContent);
	});
});
