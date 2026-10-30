import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	HTML_RENDER_CONTENT_SECURITY_POLICY,
	injectHtmlRenderBootstrap,
} from "../../src/extensions/html-render/bootstrap.ts";
import { inlineLocalImages } from "../../src/extensions/html-render/images.ts";
import { showHtmlPageTool } from "../../src/extensions/html-render/tool.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { HOST_TOOL_NAMES_CONTEXT_KEY } from "../../src/host-tools.ts";
import { createHarness } from "./harness.ts";

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 0)]);

const ctxFor = (cwd: string): ExtensionToolContext =>
	({
		cwd,
		hasUI: false,
		ui: undefined,
		tools: [],
		executeTool: () => Promise.reject(new Error("not used")),
	}) as unknown as ExtensionToolContext;

describe("host HTML attachment", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-html-render-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// #5005: host presentation tools must not enter a bare engine through its builtin catalog.
	it("does not register host HTML tools without a host attachment", async () => {
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory({ disabledBuiltinExtensions: ["codemode"] }),
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		expect(loaded.errors).toEqual([]);
		const names = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
		expect(names).not.toContain("show_html_page");
		expect(names).not.toContain("html_render");
		expect(names).not.toContain("html_preview");
	});

	it("registers show_html_page", async () => {
		const harness = await createHarness({ extensionFactories: builtInExtensions });
		try {
			const names = harness.session.getAllTools().map((tool) => tool.name);
			expect(names).toContain("show_html_page");
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		{ supplied: "show_html_page", registered: false },
		{ supplied: "another_host_tool", registered: true },
	])("yields standalone defaults only to the opening host's $supplied attachment", async (row) => {
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory({ disabledBuiltinExtensions: ["codemode"] }),
			sessionContext: { [HOST_TOOL_NAMES_CONTEXT_KEY]: row.supplied },
			extensionFactories: builtInExtensions,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		expect(loaded.errors).toEqual([]);
		const names = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
		expect(names.includes("show_html_page")).toBe(row.registered);
	});

	it.each([{ enabledBuiltinExtensions: ["goal"] }, { disabledBuiltinExtensions: ["html-render", "codemode"] }])(
		"preserves the standalone host extension's settings opt-out %j",
		async (settings) => {
			const loader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir: tempDir,
				settingsManager: SettingsManager.inMemory(settings),
				extensionFactories: builtInExtensions,
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions.flatMap((extension) => [...extension.tools.keys()])).not.toContain("show_html_page");
		},
	);

	it("writes a prepared page with the theme bootstrap injected ahead of the head content", async () => {
		const result = await showHtmlPageTool.execute(
			"call-1",
			{
				html: "<!doctype html><html><head><title>t</title></head><body>hi</body></html>",
				title: "Revenue",
				height: 260,
			},
			undefined,
			undefined,
			ctxFor(tempDir),
		);
		const path = (result.details as { path: string }).path;
		const written = readFileSync(path, "utf8");
		expect(written).toContain('id="t3-theme"');
		expect(written.indexOf('id="t3-theme"')).toBeLessThan(written.indexOf("<title>"));
		expect((result.details as { prepared: boolean }).prepared).toBe(true);
		expect(path).toContain(".senpi/html-pages");
	});

	it("opens the written page with the offline snapshot policy ahead of anything the page wrote", async () => {
		const result = await showHtmlPageTool.execute(
			"call-3",
			{
				html: '<!doctype html><script src="https://cdn.example/lib.js"></script><img src="http://127.0.0.1:1/x.png">',
				title: "Offline",
			},
			undefined,
			undefined,
			ctxFor(tempDir),
		);
		const written = readFileSync((result.details as { path: string }).path, "utf8");
		const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CONTENT_SECURITY_POLICY}">`;
		expect(written.startsWith(`\uFEFF<!doctype html>${policy}`)).toBe(true);
		expect(written.indexOf(policy)).toBeLessThan(written.indexOf("cdn.example"));
	});

	it.each(["<!-->", "<!--->", "<!-- note --!>", "<!-- note -->"])(
		"keeps the policy ahead of a script hidden behind %s before the doctype",
		(comment) => {
			const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CONTENT_SECURITY_POLICY}">`;
			const injected = injectHtmlRenderBootstrap(
				`${comment}<script>fetch("http://127.0.0.1:1/")</script>--><!doctype html><html><head></head><body>x</body></html>`,
			);
			expect(injected.startsWith(`\uFEFF<!doctype html>${policy}${comment}`)).toBe(true);
		},
	);

	it("keeps the policy readable when the page declares an encoding that would swallow it", () => {
		const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CONTENT_SECURITY_POLICY}">`;
		// ISO-2022-JP switches to two-byte text at ESC $ B; a policy written after that
		// escape would decode as kanji. The byte order mark makes the browser decode the
		// file as UTF-8, and nothing the page wrote precedes the policy.
		const injected = injectHtmlRenderBootstrap(
			'<!DOCTYPE html \u001b$B><html><head><meta charset="iso-2022-jp"><script>fetch("https://example.com/")</script></head></html>',
		);
		expect(injected.startsWith(`\uFEFF<!doctype html>${policy}`)).toBe(true);
		expect(injected.indexOf("\u001b")).toBeGreaterThan(policy.length);
	});

	it("hands the page to the host in details and never puts it in the content the model reads", async () => {
		const html = '<!doctype html><div id="marker-7f3a">chart</div>';
		const result = await showHtmlPageTool.execute(
			"call-4",
			{ html, title: "Hidden", height: 300 },
			undefined,
			undefined,
			ctxFor(tempDir),
		);
		expect((result.details as { html: string }).html).toBe(html);
		expect(JSON.stringify(result.content)).not.toContain("marker-7f3a");
	});

	it("refuses a page over the input limit before preparing anything", async () => {
		await expect(
			showHtmlPageTool.execute(
				"call-max",
				{ html: "x".repeat(512_001), title: "Big" },
				undefined,
				undefined,
				ctxFor(tempDir),
			),
		).rejects.toThrow(/512000 characters/);
		expect(existsSync(join(tempDir, ".senpi/html-pages"))).toBe(false);
	});

	it("#3418: tells the agent to pass screenshots as file paths when base64 images push a page past the limit", async () => {
		const screenshot = `<img src="data:image/png;base64,${"A".repeat(200_000)}">`;
		const html = `<html><body><h1>Report</h1>${screenshot.repeat(3)}</body></html>`;

		const refused = showHtmlPageTool.execute(
			"call-b64",
			{ html, title: "Report" },
			undefined,
			undefined,
			ctxFor(tempDir),
		);

		await expect(refused).rejects.toThrow(/3 base64 images/);
		await expect(refused).rejects.toThrow(/absolute file path/);
		expect(existsSync(join(tempDir, ".senpi/html-pages"))).toBe(false);
	});

	it("#3418: opens a report whose screenshots are absolute file paths, however large they are once inlined", async () => {
		const paths = [0, 1, 2].map((index) => {
			const path = join(tempDir, `shot-${index}.png`);
			writeFileSync(path, Buffer.concat([PNG_BYTES, Buffer.alloc(300_000, index + 1)]));
			return path;
		});
		const html = `<html><body>${paths.map((path) => `<img src="${path}">`).join("")}</body></html>`;

		const result = await showHtmlPageTool.execute(
			"call-paths",
			{ html, title: "Report" },
			undefined,
			undefined,
			ctxFor(tempDir),
		);

		const written = readFileSync((result.details as { path: string }).path, "utf8");
		expect(written.length).toBeGreaterThan(512_000);
		expect(written).toContain("data:image/png;base64,");
	});

	it("returns an error the agent can act on when inlined images push the page past 25 MiB, and writes nothing", async () => {
		const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const paths = [0, 1, 2].map((index) => {
			const path = join(tempDir, `big-${index}.png`);
			writeFileSync(path, Buffer.concat([head, Buffer.alloc(9 * 1024 * 1024, index + 1)]));
			return path;
		});
		const html = paths.map((path) => `<img src="${path}">`).join("");
		await expect(
			showHtmlPageTool.execute("call-5", { html, title: "Huge" }, undefined, undefined, ctxFor(tempDir)),
		).rejects.toThrow(/limit is 25 MiB/);
		expect(existsSync(join(tempDir, ".senpi/html-pages"))).toBe(false);
	});

	it("clamps the frame height to the 80-2000 range", async () => {
		const result = await showHtmlPageTool.execute(
			"call-2",
			{ html: "<p>x</p>", title: "Tall", height: 99999 },
			undefined,
			undefined,
			ctxFor(tempDir),
		);
		expect((result.details as { height: number }).height).toBe(2000);
	});

	it("inlines an absolute-path local image as a data URI", async () => {
		const imagePath = join(tempDir, "chart.png");
		writeFileSync(imagePath, PNG_BYTES);
		const { html, missing } = await inlineLocalImages(`<img src="${imagePath}">`);
		expect(html).toContain("data:image/png;base64,");
		expect(missing).toHaveLength(0);
	});

	it("refuses a renamed secret written to an image path", async () => {
		const secretPath = join(tempDir, "secret.png");
		writeFileSync(secretPath, "API_KEY=hunter2 not an image");
		const { html, missing } = await inlineLocalImages(`<img src="${secretPath}">`);
		expect(html).not.toContain("data:");
		expect(missing).toContain(secretPath);
	});

	it("refuses a page that grows past the page size cap when images inline", async () => {
		const bigPath = join(tempDir, "big.png");
		const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		writeFileSync(bigPath, Buffer.concat([head, Buffer.alloc(11 * 1024 * 1024, 1)]));
		await expect(inlineLocalImages(`<img src="${bigPath}">`)).rejects.toThrow(/at most 10 MiB/);
	});

	it("injects the bootstrap into a bare fragment", () => {
		const prepared = injectHtmlRenderBootstrap("<div>chart</div>");
		expect(prepared).toContain('id="t3-theme"');
		expect(prepared).toContain("<div>chart</div>");
	});
});
