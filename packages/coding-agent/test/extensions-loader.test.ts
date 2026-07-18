import type { PathLike } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.ts";

// loader.ts is dynamically imported in tests because the same file mocks
// jiti/static and node:fs via vi.doMock.
describe("extension loader", () => {
	afterEach(() => {
		vi.doUnmock("node:fs");
		vi.doUnmock("jiti/static");
		vi.resetModules();
	});

	it("reuses one jiti importer when loading an extension batch", async () => {
		const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerCommand("mock-command", {
				handler: async () => {},
			});
		};
		const importExtension = vi.fn(async () => extensionFactory);
		const createJiti = vi.fn(() => ({
			import: importExtension,
		}));

		vi.doMock("jiti/static", () => ({ createJiti }));
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");

		const result = await loadExtensions(["first.js", "second.js"], "/tmp");

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(2);
		expect(importExtension).toHaveBeenCalledTimes(2);
		expect(createJiti).toHaveBeenCalledTimes(1);
	});

	it("prefers bundled package aliases when the local coding-agent package carries dependencies", async () => {
		// given a linked local senpi install where dependencies live under
		// packages/coding-agent/node_modules instead of the workspace root
		const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.registerCommand("mock-command", {
				handler: async () => {},
			});
		};
		const importExtension = vi.fn(async () => extensionFactory);
		let capturedOptions: { readonly alias?: Record<string, string> } | undefined;
		const createJiti = vi.fn((_url: string, options: { readonly alias?: Record<string, string> }) => {
			capturedOptions = options;
			return {
				import: importExtension,
			};
		});
		const bundledTuiEntry = path.join(
			"packages",
			"coding-agent",
			"node_modules",
			"@earendil-works",
			"pi-tui",
			"dist",
			"index.js",
		);

		vi.doMock("jiti/static", () => ({ createJiti }));
		vi.doMock("node:fs", async () => {
			const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...fs,
				existsSync(targetPath: PathLike): boolean {
					return targetPath.toString().endsWith(bundledTuiEntry) || fs.existsSync(targetPath);
				},
			};
		});
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");

		// when extension loading creates the shared jiti importer
		const result = await loadExtensions(["first.js"], "/tmp");

		// then aliased upstream TUI imports resolve to the bundled copy whose
		// transitive deps are installed beside the coding-agent package
		expect(result.errors).toHaveLength(0);
		expect(capturedOptions?.alias?.["@earendil-works/pi-tui"]).toContain(bundledTuiEntry);
	});

	describe("registerMcpServer", () => {
		const bus = createEventBus();

		it("stores a valid stdio declaration with extension path and registration cwd", async () => {
			const { createExtensionRuntime, loadExtensionFromFactory } = await import("../src/core/extensions/loader.ts");
			const ext = await loadExtensionFromFactory(
				(pi) => {
					pi.registerMcpServer("stdio-fixture", {
						type: "stdio",
						command: "node",
						args: ["server.js"],
					});
				},
				"/tmp/ext-cwd",
				bus,
				createExtensionRuntime(),
				"<stdio-ext>",
			);
			const decl = ext.mcpServers.get("stdio-fixture");
			expect(decl).toBeDefined();
			expect(decl?.config).toMatchObject({ type: "stdio", command: "node", args: ["server.js"] });
			expect(decl?.extensionPath).toBe("<stdio-ext>");
			expect(decl?.registrationCwd).toBe("/tmp/ext-cwd");
		});

		it("stores a valid http declaration", async () => {
			const { createExtensionRuntime, loadExtensionFromFactory } = await import("../src/core/extensions/loader.ts");
			const ext = await loadExtensionFromFactory(
				(pi) => {
					pi.registerMcpServer("http-fixture", { type: "http", url: "http://localhost:3000" });
				},
				"/tmp",
				bus,
				createExtensionRuntime(),
			);
			expect(ext.mcpServers.get("http-fixture")?.config).toMatchObject({
				type: "http",
				url: "http://localhost:3000",
			});
		});

		it("rejects an invalid declaration and fails only the declaring extension", async () => {
			const { createExtensionRuntime, loadExtensions } = await import("../src/core/extensions/loader.ts");
			const broken: ExtensionFactory = (pi) => {
				pi.registerMcpServer("broken", {});
			};
			const healthy: ExtensionFactory = (pi) => {
				pi.registerMcpServer("healthy", { type: "stdio", command: "node" });
			};
			const result = await loadExtensions(
				["/tmp/broken.ts", "/tmp/healthy.ts"],
				"/tmp",
				bus,
				createExtensionRuntime(),
				{
					factoryResolver: (p) => (p.includes("broken") ? broken : healthy),
				},
			);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.error).toContain('Invalid MCP server declaration "broken"');
			expect(result.extensions.flatMap((e) => [...e.mcpServers.keys()])).toEqual(["healthy"]);
		});

		it("last registration wins within one factory", async () => {
			const { createExtensionRuntime, loadExtensionFromFactory } = await import("../src/core/extensions/loader.ts");
			const ext = await loadExtensionFromFactory(
				(pi) => {
					pi.registerMcpServer("dup", { type: "stdio", command: "first" });
					pi.registerMcpServer("dup", { type: "stdio", command: "second" });
				},
				"/tmp",
				bus,
				createExtensionRuntime(),
			);
			expect(ext.mcpServers.get("dup")?.config.command).toBe("second");
		});

		it("rejects unknown fields", async () => {
			const { createExtensionRuntime, loadExtensionFromFactory } = await import("../src/core/extensions/loader.ts");
			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerMcpServer("bad", { command: "node", bogus: true } as Record<string, unknown>);
					},
					"/tmp",
					bus,
					createExtensionRuntime(),
				),
			).rejects.toThrow('Invalid MCP server declaration "bad"');
		});
	});
});
