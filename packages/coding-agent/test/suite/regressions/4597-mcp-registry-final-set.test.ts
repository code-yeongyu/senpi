import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../../src/config.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionFactory, InlineExtension, RegisteredMcpServer } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader, type ResourceLoaderReloadOptions } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createModelRegistry } from "../../model-runtime-test-utils.ts";

let tempDir: string;
let agentDir: string;
let cwd: string;
let originalHome: string | undefined;

beforeEach(() => {
	tempDir = join(tmpdir(), `senpi-4597-final-set-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	agentDir = join(tempDir, "agent");
	cwd = join(tempDir, "project");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ disabledBuiltinExtensions: ["codemode", "mcp"] })}\n`,
	);
	originalHome = process.env.HOME;
	process.env.HOME = tempDir;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(tempDir, { recursive: true, force: true });
});

function writeExtension(dir: string, file: string, body: string): string {
	const path = join(dir, file);
	writeFileSync(path, `export default function (pi) {\n${body}\n}\n`);
	return path;
}

function registering(server: string, extra = ""): string {
	return `pi.registerMcpServer(${JSON.stringify(server)}, { type: "stdio", command: "never-spawned" });${extra}`;
}

async function loadAndBind(
	options: {
		extensionFactories?: InlineExtension[];
		extensionsOverride?: ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionsOverride"];
	},
	reload: ResourceLoaderReloadOptions = {},
) {
	const loader = new DefaultResourceLoader({ cwd, agentDir, ...options });
	await loader.reload(reload);
	const result = loader.getExtensions();
	const runner = new ExtensionRunner(
		result.extensions,
		result.runtime,
		cwd,
		SessionManager.inMemory(),
		await createModelRegistry(AuthStorage.create(join(tempDir, "auth.json"))),
	);
	return { paths: result.extensions.map((extension) => extension.path), errors: result.errors, runner };
}

interface Arranged {
	readonly dropped: string;
	/** The surviving registration: its name and the path of the extension the runner keeps. */
	readonly kept: { name: string; extensionPath: string };
	readonly factories?: InlineExtension[];
	readonly override?: boolean;
	readonly reload?: ResourceLoaderReloadOptions;
}

interface DropPath {
	readonly name: string;
	readonly arrange: () => Arranged;
}

const dropPaths: readonly DropPath[] = [
	{
		name: "a replaceable factory replaced by a file extension registering the same command",
		arrange: () => {
			const other = writeExtension(
				join(agentDir, "extensions"),
				"other-mcp.ts",
				`pi.registerCommand("mcp", { description: "other", handler: async () => {} });${registering("kept")}`,
			);
			const factory: ExtensionFactory = (pi) => {
				pi.registerCommand("mcp", { description: "replaceable", handler: async () => {} });
				pi.registerMcpServer("dropped", { type: "stdio", command: "never-spawned" });
			};
			return {
				dropped: "<inline:mcp>",
				kept: { name: "kept", extensionPath: other },
				factories: [{ name: "mcp", replaceable: true, factory }],
			};
		},
	},
	{
		name: "a pre-trust user extension that the trusted project's alias of the same package shadows",
		arrange: () => {
			const sharedDir = join(tempDir, "shared-ext");
			mkdirSync(sharedDir, { recursive: true });
			writeExtension(sharedDir, "shared.ts", registering("kept"));
			rmSync(join(agentDir, "extensions"), { recursive: true, force: true });
			symlinkSync(sharedDir, join(agentDir, "extensions"), "dir");
			symlinkSync(sharedDir, join(cwd, CONFIG_DIR_NAME, "extensions"), "dir");
			return {
				dropped: join(agentDir, "extensions", "shared.ts"),
				kept: { name: "kept", extensionPath: join(cwd, CONFIG_DIR_NAME, "extensions", "shared.ts") },
				reload: { resolveProjectTrust: async () => true },
			};
		},
	},
	{
		name: "an extension removed by extensionsOverride",
		arrange: () => {
			const over = writeExtension(join(agentDir, "extensions"), "over.ts", registering("dropped"));
			const kept = writeExtension(join(agentDir, "extensions"), "kept.ts", registering("kept"));
			return { dropped: over, kept: { name: "kept", extensionPath: kept }, override: true };
		},
	},
];

describe("senpi#4597: the MCP registry reflects only the final bound extension set", () => {
	it.each(dropPaths)("hides the registrations of $name", async ({ arrange }) => {
		const { dropped, kept, factories, override, reload } = arrange();
		let seenByExtension: RegisteredMcpServer[] | undefined;
		const probe: ExtensionFactory = (pi) => {
			pi.on("session_start", () => {
				seenByExtension = pi.getMcpServers();
			});
		};
		const { paths, errors, runner } = await loadAndBind(
			{
				extensionFactories: [...(factories ?? []), { name: "probe", factory: probe }],
				...(override
					? {
							extensionsOverride: (base) => ({
								...base,
								extensions: base.extensions.filter((extension) => extension.path !== dropped),
							}),
						}
					: {}),
			},
			reload,
		);

		expect(errors).toEqual([]);
		expect(paths).not.toContain(dropped);
		const identity = ({ name, extensionPath }: RegisteredMcpServer) => ({ name, extensionPath });
		expect(runner.getRegisteredMcpServers().map(identity)).toEqual([kept]);
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(seenByExtension?.map(identity)).toEqual([kept]);
	});

	it("keeps the runner's extension order for a name clash: a factory beats a file extension loaded earlier", async () => {
		writeExtension(join(agentDir, "extensions"), "file.ts", registering("dup"));
		const factory: ExtensionFactory = (pi) => pi.registerMcpServer("dup", { type: "stdio", command: "from-factory" });
		const { paths, runner } = await loadAndBind({ extensionFactories: [{ name: "fac", factory }] });

		expect(paths.indexOf("<inline:fac>")).toBeLessThan(paths.indexOf(join(agentDir, "extensions", "file.ts")));
		const servers = runner.getRegisteredMcpServers();
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({ name: "dup", extensionPath: "<inline:fac>" });
		expect(servers[0]?.config.command).toBe("from-factory");
	});
});
