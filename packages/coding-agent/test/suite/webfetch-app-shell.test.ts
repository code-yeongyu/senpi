import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BrowserSkillError,
	createBrowserSkillRenderer,
	type PageRenderer,
} from "../../src/core/extensions/builtin/webfetch/webfetch/browser-skill.ts";
import { looksLikeAppShell } from "../../src/core/extensions/builtin/webfetch/webfetch/content.ts";
import { createWebfetchTool, type WebfetchDetails } from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";

// senpi#5939: an app shell is rendered only through the user's connected BrowserSkill browser; otherwise the
// static result stands with a typed reason. webfetch never launches a browser of its own.
const APP_SHELL = `<!doctype html><html><head><title>Board</title>
<script type="module" src="/assets/index.js"></script></head>
<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>`;
const RENDERED = `<!doctype html><html><head><title>Board</title></head><body><div id="root">
<main><h1>Team board</h1><p>Three cards are waiting for review, and the release column is empty this week.</p>
<p>Drag a card to the done column once its pull request has merged and the release notes are written.</p></main>
</div></body></html>`;
const ARTICLE = `<!doctype html><html><head><title>Notes</title><script src="/analytics.js"></script></head>
<body><article><h1>Release notes</h1><p>${"This release fixes the reader so long articles keep every paragraph. ".repeat(6)}</p></article></body></html>`;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function closeLater(server: Server | SocketServer): void {
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

async function serveHtml(html: string): Promise<string> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(html);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closeLater(server);
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}/app`;
}

interface DaemonCall {
	readonly method: string;
	readonly params: Record<string, unknown>;
}

/** A BrowserSkill daemon stand-in: daemon.json in a temp BSK_HOME and JSON Lines over its Unix socket. */
async function fakeDaemon(
	handler: (call: DaemonCall) => { result?: unknown; error?: { code: string; message: string } },
): Promise<{ readonly home: string; readonly calls: DaemonCall[] }> {
	const home = mkdtempSync(join(tmpdir(), "bsk-"));
	cleanups.push(() => rmSync(home, { recursive: true, force: true }));
	const sockPath = join(home, "d.sock");
	const calls: DaemonCall[] = [];
	const server = createSocketServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const frame = JSON.parse(buffer.slice(0, newline)) as {
				id: string;
				method: string;
				params: Record<string, unknown>;
			};
			const call = { method: frame.method, params: frame.params };
			calls.push(call);
			socket.end(`${JSON.stringify({ id: frame.id, ...handler(call) })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(sockPath, resolve));
	closeLater(server);
	writeFileSync(join(home, "daemon.json"), JSON.stringify({ sock_path: sockPath }));
	return { home, calls };
}

const CONNECTED = [{ instance_id: "b1", browser_name: "chrome", unresponsive: false }];

function connectedBrowser(pageUrl: string) {
	return (call: DaemonCall) => {
		switch (call.method) {
			case "system.status":
				return { result: { browsers: CONNECTED, sessions: [] } };
			case "session.start":
				return { result: { session_id: "s1" } };
			case "tool.navigate":
				return { result: { tab_id: 1, url: pageUrl, final_url: pageUrl, reached: "networkidle" } };
			case "tool.get_html":
				return { result: { html: RENDERED, truncated: false, byte_size: RENDERED.length, tab_id: 1 } };
			default:
				return { result: {} };
		}
	};
}

async function fetchWith(renderer: PageRenderer, url: string, format: "markdown" | "text" | "html" = "markdown") {
	const tool = createWebfetchTool({ renderer });
	const result = await tool.execute(
		"tool",
		{ url, format, timeout: 5 },
		undefined,
		undefined,
		{} as ExtensionToolContext,
	);
	const details = result.details as WebfetchDetails;
	const texts = result.content.flatMap((part) => (part.type === "text" ? [part] : []));
	const userText = texts
		.filter((part) => !("audience" in part))
		.map((part) => part.text)
		.join("");
	const modelNotes = texts.filter((part) => "audience" in part).map((part) => part.text);
	return { details, userText, modelNotes };
}

describe("webfetch app-shell detection", () => {
	it.each([
		["empty mount point with a module script", APP_SHELL, true],
		["empty body with an inline bootstrap script", "<html><body><script>start()</script></body></html>", true],
		["article page that also loads a script", ARTICLE, false],
		[
			"short static page with no script",
			"<html><body><h1>Example Domain</h1><p>For examples.</p></body></html>",
			false,
		],
		["only a JSON-LD script", '<html><body><script type="application/ld+json">{}</script></body></html>', false],
	])("%s -> %s", (_name, html, expected) => {
		expect(looksLikeAppShell(html, "https://example.test/")).toBe(expected);
	});
});

describe("webfetch reads app shells through the user's connected browser (senpi#5939)", () => {
	it("renders through the BrowserSkill daemon and stops the session it started", async () => {
		const url = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(connectedBrowser(url));

		const { details, userText, modelNotes } = await fetchWith(
			createBrowserSkillRenderer({ home: daemon.home, settlePollMs: 0 }),
			url,
		);

		expect(userText).toContain("Three cards are waiting for review");
		expect(details.rendered).toBe(true);
		expect(modelNotes.join("\n")).toContain("your connected browser (BrowserSkill)");
		expect(daemon.calls.map((call) => call.method)).toEqual([
			"system.status",
			"session.start",
			"tool.navigate",
			"tool.get_html",
			"tool.get_html",
			"session.stop",
		]);
		expect(daemon.calls[1]?.params).toEqual({ task_name: "webfetch", focused: false });
		expect(daemon.calls[2]?.params).toMatchObject({ session_id: "s1", url, wait_until: "networkidle" });
		expect(daemon.calls.at(-1)?.params).toEqual({ session_id: "s1" });
	});

	it.each([
		["no daemon is running", undefined, "integration_not_running"],
		["the daemon has no browser connected", { browsers: [], sessions: [] }, "no_browser_connected"],
		[
			"the only browser is unresponsive",
			{ browsers: [{ ...CONNECTED[0], unresponsive: true }], sessions: [] },
			"browser_unresponsive",
		],
	] as const)("keeps the static result with a typed reason when %s", async (_name, status, reason) => {
		const url = await serveHtml(APP_SHELL);
		const home =
			status === undefined
				? mkdtempSync(join(tmpdir(), "bsk-"))
				: (await fakeDaemon(() => ({ result: status }))).home;
		if (status === undefined) cleanups.push(() => rmSync(home, { recursive: true, force: true }));

		const { details, userText, modelNotes } = await fetchWith(createBrowserSkillRenderer({ home }), url);

		expect(userText.trim()).toBe("");
		expect(details.rendered).toBe(false);
		expect(details.renderSkipped?.reason).toBe(reason);
		expect(modelNotes.join("\n")).toContain(reason);
	});

	it("never contacts the browser for a page whose static HTML already has content", async () => {
		const url = await serveHtml(ARTICLE);
		const daemon = await fakeDaemon(connectedBrowser(url));

		const { details, userText } = await fetchWith(createBrowserSkillRenderer({ home: daemon.home }), url);

		expect(daemon.calls).toEqual([]);
		expect(userText).toContain("long articles keep every paragraph");
		expect(details.rendered).toBe(false);
		expect(details.renderSkipped).toBeUndefined();
	});

	it("maps an unknown renderer failure to render_failed", async () => {
		const url = await serveHtml(APP_SHELL);
		const renderer: PageRenderer = {
			name: "test",
			render: () => Promise.reject(new Error("socket hang up")),
		};

		const { details } = await fetchWith(renderer, url);

		expect(details.renderSkipped).toEqual({ reason: "render_failed", message: "socket hang up" });
	});

	it("leaves raw html requests on the static body and reports PI_WEBFETCH_RENDER=0 as disabled", async () => {
		const url = await serveHtml(APP_SHELL);
		const calls: string[] = [];
		const renderer: PageRenderer = {
			name: "test",
			render: (target) => {
				calls.push(target);
				return Promise.reject(new BrowserSkillError("render_failed", "must not render"));
			},
		};

		const raw = await fetchWith(renderer, url, "html");
		vi.stubEnv("PI_WEBFETCH_RENDER", "0");
		const disabled = await fetchWith(renderer, url);

		expect(calls).toEqual([]);
		expect(raw.userText).toBe(APP_SHELL);
		expect(disabled.details.renderSkipped?.reason).toBe("disabled");
	});
});
