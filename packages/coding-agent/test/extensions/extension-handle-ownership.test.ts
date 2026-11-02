import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reclaimExtensionHandles, runOwnedBy } from "../../src/core/extensions/extension-handle-ledger.ts";
import type { Extension } from "../../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";

const FIXTURE_SOURCE = [
	'import net from "node:net";',
	"export function open() {",
	"\tconst interval = setInterval(() => {}, 60_000);",
	"\tconst server = net.createServer();",
	'\tconst listening = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
	"\treturn { server, interval, listening };",
	"}",
].join("\n");

interface FixtureModule {
	open(): { server: Server; interval: ReturnType<typeof setInterval>; listening: Promise<void> };
}

function fakeExtension(resolvedPath: string, source: string, baseDir: string | undefined): Extension {
	return {
		path: resolvedPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(resolvedPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		removedToolHints: new Map(),
		lazyToolActivators: [],
		filesystemPolicies: [],
		messageRenderers: new Map(),
		memoryReporters: new Map(),
		entryRenderers: undefined,
		commands: new Map(),
		rpcHandlers: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		mcpServers: new Map(),
		registrationCwd: baseDir ?? process.cwd(),
	};
}

const activeTimeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

describe("extension handle ownership (senpi#2292)", () => {
	let directory: string;
	let fixture: FixtureModule;
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "handle-ownership-"));
		const file = join(directory, "fixture.mjs");
		writeFileSync(file, FIXTURE_SOURCE);
		// A package extension owns its whole directory; a single-file extension owns only its entry file.
		writeFileSync(join(directory, "package.json"), "{}");
		// The fixture must be a real file under the extension's directory: ownership is decided by the creating frame's path.
		fixture = await import(pathToFileURL(file).href);
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	});

	it("closes what the extension's own code left open and reports it per extension", async () => {
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const before = activeTimeouts();
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;
		expect(activeTimeouts()).toBe(before + 1);

		reclaimExtensionHandles([extension]);

		expect(opened.server.listening).toBe(false);
		expect(activeTimeouts()).toBe(before);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(`Extension ${extension.path} left handles open`);
		expect(String(warn.mock.calls[0]?.[0])).toContain("senpi closed 1 server, 0 sockets, 1 timer");
	});

	it("leaves handles alone that code outside the extension created on its behalf", () => {
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const interval = runOwnedBy(extension, () => setInterval(() => {}, 60_000));
		const before = activeTimeouts();

		reclaimExtensionHandles([extension]);

		expect(activeTimeouts()).toBe(before);
		expect(warn).not.toHaveBeenCalled();
		clearInterval(interval);
	});

	it("reports nothing when the extension released its handles itself", async () => {
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;
		clearInterval(opened.interval);
		await new Promise<void>((resolve) => opened.server.close(() => resolve()));

		reclaimExtensionHandles([extension]);

		expect(warn).not.toHaveBeenCalled();
	});

	it("never tracks builtin extensions", async () => {
		const extension = fakeExtension("builtin:fixture", "builtin", directory);
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;

		reclaimExtensionHandles([extension]);

		expect(opened.server.listening).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		clearInterval(opened.interval);
		await new Promise<void>((resolve) => opened.server.close(() => resolve()));
	});

	it("never tracks inline factories, whose handles cannot be told from senpi's own", async () => {
		const extension = fakeExtension("<inline>", "local", undefined);
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;

		reclaimExtensionHandles([extension]);

		expect(opened.server.listening).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		clearInterval(opened.interval);
		await new Promise<void>((resolve) => opened.server.close(() => resolve()));
	});

	it("still reclaims a file extension whose source info was relabelled after its factory ran", async () => {
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;
		extension.sourceInfo = createSyntheticSourceInfo(extension.path, { source: "cli", baseDir: undefined });

		reclaimExtensionHandles([extension]);

		expect(opened.server.listening).toBe(false);
		expect(String(warn.mock.calls[0]?.[0])).toContain("senpi closed 1 server, 0 sockets, 1 timer");
	});

	it("leaves alone what a bundled extension opened once it was relabelled builtin", async () => {
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;
		extension.sourceInfo = createSyntheticSourceInfo(extension.path, { source: "builtin", baseDir: directory });

		reclaimExtensionHandles([extension]);

		expect(opened.server.listening).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		clearInterval(opened.interval);
		await new Promise<void>((resolve) => opened.server.close(() => resolve()));
	});

	it("gives a directory extension (index entry, no package.json) what its sibling modules created", async () => {
		const extensionDir = mkdtempSync(join(tmpdir(), "handle-ownership-dir-"));
		try {
			writeFileSync(join(extensionDir, "server.mjs"), FIXTURE_SOURCE);
			const sibling: FixtureModule = await import(pathToFileURL(join(extensionDir, "server.mjs")).href);
			const extension = fakeExtension(join(extensionDir, "index.ts"), "local", extensionDir);
			const opened = runOwnedBy(extension, () => sibling.open());
			await opened.listening;

			reclaimExtensionHandles([extension]);

			expect(opened.server.listening).toBe(false);
			expect(String(warn.mock.calls[0]?.[0])).toContain("senpi closed 1 server, 0 sockets, 1 timer");
		} finally {
			rmSync(extensionDir, { recursive: true, force: true });
		}
	});

	it("does not give a single-file extension what a neighbour in its directory created", async () => {
		const loose = mkdtempSync(join(tmpdir(), "handle-ownership-loose-"));
		try {
			writeFileSync(join(loose, "neighbour.mjs"), FIXTURE_SOURCE);
			const neighbour: FixtureModule = await import(pathToFileURL(join(loose, "neighbour.mjs")).href);
			const extension = fakeExtension(join(loose, "single.ts"), "local", loose);
			const opened = runOwnedBy(extension, () => neighbour.open());
			await opened.listening;

			reclaimExtensionHandles([extension]);

			expect(opened.server.listening).toBe(true);
			expect(warn).not.toHaveBeenCalled();
			clearInterval(opened.interval);
			await new Promise<void>((resolve) => opened.server.close(() => resolve()));
		} finally {
			rmSync(loose, { recursive: true, force: true });
		}
	});

	it("does not give an extension what senpi's own packages created inside its directory", async () => {
		const senpiPackage = join(directory, "node_modules", "@code-yeongyu", "senpi-tui");
		mkdirSync(senpiPackage, { recursive: true });
		writeFileSync(join(senpiPackage, "render.mjs"), FIXTURE_SOURCE);
		const senpiCode: FixtureModule = await import(pathToFileURL(join(senpiPackage, "render.mjs")).href);
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const opened = runOwnedBy(extension, () => senpiCode.open());
		await opened.listening;

		reclaimExtensionHandles([extension]);

		expect(opened.server.listening).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		clearInterval(opened.interval);
		await new Promise<void>((resolve) => opened.server.close(() => resolve()));
	});
});
