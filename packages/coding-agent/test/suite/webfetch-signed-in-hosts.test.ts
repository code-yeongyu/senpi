import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BrowserSkillError,
	NOT_CONNECTED_MESSAGE,
	type PageRenderer,
	type PageRenderOptions,
} from "../../src/core/extensions/builtin/webfetch/webfetch/browser-skill.ts";
import {
	isSignedInHost,
	parseSignedInBrowserSettings,
	readSignedInBrowserSettings,
	type SignedInBrowserSettings,
} from "../../src/core/extensions/builtin/webfetch/webfetch/signed-in-hosts.ts";
import { createWebfetchTool, type WebfetchDetails } from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";

// senpi#5940 (design: issuecomment-6651347167): a signed-in read is a user-only opt-in from GLOBAL settings, scoped to listed
// hosts, read without writing settings; it never leaks to an unlisted host (security contract).
const LOGIN_PAGE =
	"<html><head><title>Sign in</title></head><body><h1>Sign in</h1><p>Use your account.</p></body></html>";
const SIGNED_IN_PAGE = `<html><head><title>Team wiki</title><script>window.__CSRF__="csrf-secret-9"</script></head><body><main><h1>Roadmap</h1>
<p>Only a signed-in member can read this roadmap page, which lists the next three releases and their owners.</p></main></body></html>`;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(html: string): Promise<{ readonly url: string; readonly requests: string[] }> {
	const requests: string[] = [];
	const server: Server = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.writeHead(200, { "content-type": "text/html" });
		response.end(html);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Expected TCP server address");
	return { url: `http://127.0.0.1:${address.port}/wiki/roadmap`, requests };
}

function browser(page: (url: string) => { url: string; html: string } | Error) {
	const calls: Array<{ url: string; options: PageRenderOptions }> = [];
	const renderer: PageRenderer = {
		name: "your connected browser (BrowserSkill)",
		async render(url, options) {
			calls.push({ url, options });
			const result = page(url);
			if (result instanceof Error) throw result;
			return {
				page: { ...result, truncated: false },
				browser: { instanceId: "b1", browserName: "chrome", label: "Work Chrome" },
			};
		},
	};
	return { renderer, calls };
}

async function fetchAs(
	settings: SignedInBrowserSettings,
	renderer: PageRenderer,
	url: string,
	format: "markdown" | "html" = "markdown",
) {
	const tool = createWebfetchTool({ renderer, signedInSettings: () => settings });
	const result = await tool.execute("tool", { url, format }, undefined, undefined, {} as ExtensionToolContext);
	const text = result.content
		.flatMap((part) => (part.type === "text" && !("audience" in part) ? [part.text] : []))
		.join("");
	return { details: result.details as WebfetchDetails, text };
}

describe("signed-in browser settings", () => {
	it.each([
		["no webfetch section", {}, { hosts: [] }],
		["hosts is not a list", { webfetch: { signedInBrowser: { hosts: "a.test" } } }, { hosts: [] }],
		[
			"invalid entries are dropped, the rest normalized, the browser pin kept",
			{
				webfetch: {
					signedInBrowser: {
						hosts: [
							" Wiki.Example.test ",
							"*.corp.test",
							"https://x.test/",
							"a.test:8080",
							"user@a.test",
							"b.test.",
							"*.com",
							"wiki.例え.jp",
							3,
						],
						browser: " Work Chrome ",
					},
				},
			},
			{ hosts: ["wiki.example.test", "*.corp.test"], browser: "Work Chrome" },
		],
	])("%s", (_name, settings, expected) => {
		expect(parseSignedInBrowserSettings(settings)).toEqual(expected);
	});

	it.each([
		["https://wiki.example.test/page", true],
		["https://wiki.example.test:8443/page", true],
		["https://user:pass@wiki.example.test/page", true],
		["https://evil.test/?wiki.example.test", false],
		["https://wiki.example.test.evil.test/", false],
		["https://xwiki.example.test/", false],
		["https://wiki.example.test./", false],
		["https://docs.corp.test/a", true],
		["https://a.b.corp.test/a", true],
		["https://corp.test/a", false],
		["https://[::1]/", false],
		["file:///etc/hosts", false],
	])("host match %s -> %s", (url, expected) => {
		expect(isSignedInHost(url, ["wiki.example.test", "*.corp.test"])).toBe(expected);
	});

	it("reads only the global file and never writes it, even when it carries a retired key", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-agent-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		const file = join(agentDir, "settings.json");
		const body = JSON.stringify({
			retiredKeyFromOldRelease: true,
			webfetch: { signedInBrowser: { hosts: ["wiki.example.test"] } },
		});
		writeFileSync(file, body);
		const before = statSync(file).mtimeMs;

		const settings = readSignedInBrowserSettings(agentDir);

		expect(settings).toEqual({ hosts: ["wiki.example.test"] });
		expect(readFileSync(file, "utf8")).toBe(body);
		expect(statSync(file).mtimeMs).toBe(before);
	});

	it("ignores hosts that only a project settings file lists", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-agent-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		const project = join(agentDir, "repo", ".senpi");
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, "settings.json"),
			JSON.stringify({ webfetch: { signedInBrowser: { hosts: ["wiki.example.test"] } } }),
		);

		expect(readSignedInBrowserSettings(agentDir)).toEqual({ hosts: [] });
	});
});

describe("webfetch through the signed-in browser (senpi#5940)", () => {
	it("never contacts the browser for a host the user did not list", async () => {
		const site = await serve(LOGIN_PAGE);
		const { renderer, calls } = browser((url) => ({ url, html: SIGNED_IN_PAGE }));

		const { details, text } = await fetchAs({ hosts: [] }, renderer, site.url);

		expect(calls).toEqual([]);
		expect(text).toContain("Use your account.");
		expect(details.route).toBe("http");
	});

	it("reads a listed host in a normal (signed-in) session with the pinned browser and no anonymous request", async () => {
		const site = await serve(LOGIN_PAGE);
		const { renderer, calls } = browser((url) => ({ url, html: SIGNED_IN_PAGE }));

		const { details, text } = await fetchAs({ hosts: ["127.0.0.1"], browser: "Work Chrome" }, renderer, site.url);

		expect(calls.map((call) => [call.url, call.options.mode, call.options.browser])).toEqual([
			[site.url, "signed-in", "Work Chrome"],
		]);
		expect(site.requests).toEqual([]);
		expect(text).toContain("Only a signed-in member can read this roadmap page");
		expect(details).toMatchObject({
			route: "signed-in-browser",
			finalUrl: site.url,
			converted: true,
			rendered: true,
		});
		expect(details.browser).toEqual({ instanceId: "b1", browserName: "chrome", label: "Work Chrome" });
	});

	it("strips scripts from a signed-in read in every format, raw html included", async () => {
		const site = await serve(LOGIN_PAGE);
		const { renderer } = browser((url) => ({ url, html: SIGNED_IN_PAGE }));

		const markdown = await fetchAs({ hosts: ["127.0.0.1"] }, renderer, site.url);
		const html = await fetchAs({ hosts: ["127.0.0.1"] }, renderer, site.url, "html");

		expect(markdown.text).not.toContain("csrf-secret-9");
		expect(html.text).not.toContain("csrf-secret-9");
		expect(html.text).toContain("Roadmap");
	});

	it("falls back to the anonymous read with the typed not-connected reason", async () => {
		const site = await serve(LOGIN_PAGE);
		const { renderer } = browser(
			() =>
				new BrowserSkillError({
					reason: "integration_not_connected",
					cause: "no_daemon",
					message: NOT_CONNECTED_MESSAGE,
					detail: "no readable daemon.json",
				}),
		);

		const { details, text } = await fetchAs({ hosts: ["127.0.0.1"] }, renderer, site.url);

		expect(site.requests).toEqual(["/wiki/roadmap"]);
		expect(text).toContain("Use your account.");
		expect(details.route).toBe("http");
		expect(details.signedInSkipped).toEqual({
			reason: "integration_not_connected",
			cause: "no_daemon",
			message: "browser integration not connected; render skipped",
			detail: "no readable daemon.json",
		});
	});

	it("discards a signed-in read that ended on an unlisted host and reads the original URL anonymously", async () => {
		const site = await serve(LOGIN_PAGE);
		const { renderer } = browser(() => ({ url: "https://mail.other.test/inbox", html: SIGNED_IN_PAGE }));

		const { details, text } = await fetchAs({ hosts: ["127.0.0.1"] }, renderer, site.url);

		expect(text).not.toContain("roadmap page");
		expect(site.requests).toEqual(["/wiki/roadmap"]);
		expect(details.route).toBe("http");
		expect(details.signedInSkipped?.reason).toBe("host_not_allowed");
		expect(details.signedInSkipped?.detail).toContain("mail.other.test");
	});
});
