import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createBrowserSkillRenderer,
	NOT_CONNECTED_MESSAGE,
	type BrowserSkillOptions,
} from "../../src/core/extensions/builtin/webfetch/webfetch/browser-skill.ts";
import { looksLikeAppShell } from "../../src/core/extensions/builtin/webfetch/webfetch/content.ts";
import { createWebfetchTool, type WebfetchDetails } from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";

// senpi#5939 (design: senpi#5940 issuecomment-6651347167): an app shell is rendered ONLY through the user's connected
// BrowserSkill browser, in an incognito window; otherwise the static result stands with a typed reason. webfetch never
// launches a browser or starts the daemon.
const APP_SHELL = `<!doctype html><html><head><title>Board</title>
<script type="module" src="/assets/index.js"></script></head>
<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>`;
const RENDERED = `<!doctype html><html><head><title>Board</title><script>window.__TOKEN__="secret-token-123"</script></head><body><div id="root">
<main><h1>Team board</h1><p>Three cards are waiting for review, and the release column is empty this week.</p>
<p>Drag a card to the done column once its pull request has merged and the release notes are written.</p></main>
</div></body></html>`;
const ARTICLE = `<!doctype html><html><head><title>Notes</title><script src="/analytics.js"></script></head>
<body><article><h1>Release notes</h1><p>${"This release fixes the reader so long articles keep every paragraph. ".repeat(6)}</p></article></body></html>`;
const FIVE_MIB = 5 * 1024 * 1024;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function closeLater(server: Server | SocketServer): void {
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

function tempHome(): string {
	const home = mkdtempSync(join(tmpdir(), "bsk-"));
	cleanups.push(() => rmSync(home, { recursive: true, force: true }));
	return home;
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

type Reply = { result?: unknown; error?: { code: string; message: string; data?: unknown }; id?: string } | "never";

interface FakeDaemon {
	readonly home: string;
	readonly calls: DaemonCall[];
	connections: number;
	liveSessions: number;
	maxLiveSessions: number;
}

/** A BrowserSkill daemon stand-in: daemon.json in a temp BSK_HOME and JSON Lines over its Unix socket. */
async function fakeDaemon(handler: (call: DaemonCall) => Reply | Promise<Reply>): Promise<FakeDaemon> {
	const home = tempHome();
	const sockPath = join(home, "d.sock");
	const daemon: FakeDaemon = { home, calls: [], connections: 0, liveSessions: 0, maxLiveSessions: 0 };
	const server = createSocketServer((socket) => {
		daemon.connections++;
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("error", () => {});
		socket.on("data", async (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const frame = JSON.parse(buffer.slice(0, newline)) as {
				id: string;
				method: string;
				params: Record<string, unknown>;
			};
			const call = { method: frame.method, params: frame.params };
			daemon.calls.push(call);
			if (call.method === "session.start") {
				daemon.liveSessions++;
				daemon.maxLiveSessions = Math.max(daemon.maxLiveSessions, daemon.liveSessions);
			}
			if (call.method === "session.stop") daemon.liveSessions--;
			const reply = await handler(call);
			if (reply === "never") return;
			socket.end(`${JSON.stringify({ ...reply, id: reply.id ?? frame.id })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(sockPath, resolve));
	closeLater(server);
	writeFileSync(join(home, "daemon.json"), JSON.stringify({ sock_path: sockPath }));
	return daemon;
}

const BROWSER = {
	instance_id: "b1",
	browser_name: "chrome",
	label: "Home Chrome",
	unresponsive: false,
	connected_at_ms: 100,
	extension_protocol_version: "1.4",
};

function status(browsers: unknown[] = [BROWSER], protocol = "1.4") {
	return { result: { daemon_version: "0.4.0", protocol_version: protocol, browsers, sessions: [] } };
}

function connectedBrowser(
	pageUrl: string,
	overrides: Partial<Record<string, (call: DaemonCall) => Reply | Promise<Reply>>> = {},
) {
	return (call: DaemonCall): Reply | Promise<Reply> => {
		const override = overrides[call.method];
		if (override) return override(call);
		switch (call.method) {
			case "system.status":
				return status();
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

function renderer(daemon: { home: string }, options: Partial<BrowserSkillOptions> = {}) {
	return createBrowserSkillRenderer({ home: daemon.home, settlePollMs: 0, statusTimeoutMs: 200, ...options });
}

async function fetchWith(
	tool: ReturnType<typeof createWebfetchTool>,
	url: string,
	format: "markdown" | "text" | "html" = "markdown",
	signal?: AbortSignal,
	timeout = 5,
) {
	const result = await tool.execute("tool", { url, format, timeout }, signal, undefined, {} as ExtensionToolContext);
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

describe("webfetch renders app shells only through the connected browser, incognito (senpi#5939)", () => {
	it("renders in an incognito session of the picked browser with the exact verb set, and strips scripts", async () => {
		const url = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(connectedBrowser(url));
		const tool = createWebfetchTool({ renderer: renderer(daemon) });

		const { details, userText, modelNotes } = await fetchWith(tool, url);

		expect(userText).toContain("Three cards are waiting for review");
		expect(userText).not.toContain("secret-token-123");
		expect(details).toMatchObject({ rendered: true, browser: { instanceId: "b1", label: "Home Chrome" } });
		expect(modelNotes.join("\n")).toContain("incognito window without your cookies");
		expect(daemon.calls.map((call) => call.method)).toEqual([
			"system.status",
			"session.start",
			"tool.navigate",
			"tool.get_html",
			"tool.get_html",
			"session.stop",
		]);
		expect(daemon.calls[1]?.params).toEqual({
			task_name: "webfetch",
			controller: { name: "senpi webfetch" },
			browser_instance_id: "b1",
			incognito: true,
			focused: false,
		});
		expect(daemon.calls[3]?.params).toEqual({ session_id: "s1", max_bytes: FIVE_MIB });
	});

	it("reports the exact not-connected message and connects to nothing when no daemon.json exists", async () => {
		const url = await serveHtml(APP_SHELL);
		const tool = createWebfetchTool({ renderer: renderer({ home: tempHome() }) });

		const { details, userText } = await fetchWith(tool, url);

		expect(userText.trim()).toBe("");
		expect(details.rendered).toBe(false);
		expect(details.renderSkipped).toMatchObject({ reason: "integration_not_connected", cause: "no_daemon" });
		expect(details.renderSkipped?.message).toBe("browser integration not connected; render skipped");
		expect(NOT_CONNECTED_MESSAGE).toBe("browser integration not connected; render skipped");
	});

	it.each([
		[
			"a regular file",
			(home: string) => writeFileSync(join(home, "plain"), "x") ?? join(home, "plain"),
			"not a socket",
		],
		["a relative path", () => "relative.sock", "not absolute"],
	])("refuses a daemon.json socket that is %s as no_daemon", async (_name, makePath, detail) => {
		const url = await serveHtml(APP_SHELL);
		const home = tempHome();
		const sockPath = makePath(home);
		writeFileSync(
			join(home, "daemon.json"),
			JSON.stringify({ sock_path: sockPath === undefined ? join(home, "plain") : sockPath }),
		);
		const tool = createWebfetchTool({ renderer: renderer({ home }) });

		const { details } = await fetchWith(tool, url);

		expect(details.renderSkipped).toMatchObject({ reason: "integration_not_connected", cause: "no_daemon" });
		expect(details.renderSkipped?.detail).toContain(detail);
	});

	it("refuses a socket owned by another user without connecting", async () => {
		const url = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(connectedBrowser(url));
		const tool = createWebfetchTool({ renderer: renderer(daemon, { ownerUid: 4_000_000 }) });

		const { details } = await fetchWith(tool, url);

		expect(daemon.connections).toBe(0);
		expect(details.renderSkipped).toMatchObject({
			cause: "no_daemon",
			detail: "the daemon socket belongs to another user",
		});
	});

	const statusCases: Array<[string, () => Reply, string]> = [
		["a status that never answers", () => "never" as const, "daemon_unreachable"],
		["a mismatched reply id", () => ({ ...status(), id: "someone-else" }), "incompatible"],
		["a non-object result", () => ({ result: "ok" }), "incompatible"],
		["protocol 2.0", () => status([BROWSER], "2.0"), "incompatible"],
		["no browser", () => status([]), "no_browser"],
		["only unresponsive browsers", () => status([{ ...BROWSER, unresponsive: true }]), "browser_unresponsive"],
	];
	it.each(statusCases)("maps %s to integration_not_connected/%s", async (_name, statusReply, cause) => {
		const url = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(connectedBrowser(url, { "system.status": statusReply }));
		const tool = createWebfetchTool({ renderer: renderer(daemon, { statusTimeoutMs: 50 }) });

		const { details } = await fetchWith(tool, url);

		expect(details.renderSkipped).toMatchObject({ reason: "integration_not_connected", cause });
		expect(daemon.calls.some((call) => call.method === "session.start")).toBe(false);
	});

	it("sends the responsive browser, else the most recently connected one", async () => {
		const url = await serveHtml(APP_SHELL);
		const older = { ...BROWSER, instance_id: "old", connected_at_ms: 1 };
		const newer = { ...BROWSER, instance_id: "new", connected_at_ms: 9 };
		const stale = { ...BROWSER, instance_id: "stale", connected_at_ms: 99, unresponsive: true };
		const daemon = await fakeDaemon(connectedBrowser(url, { "system.status": () => status([older, stale, newer]) }));

		await fetchWith(createWebfetchTool({ renderer: renderer(daemon) }), url);

		expect(daemon.calls[1]?.params.browser_instance_id).toBe("new");
	});

	it("skips an extension below protocol 1.4 as incognito_unsupported without starting a session", async () => {
		const url = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(
			connectedBrowser(url, { "system.status": () => status([{ ...BROWSER, extension_protocol_version: "1.3" }]) }),
		);

		const { details } = await fetchWith(createWebfetchTool({ renderer: renderer(daemon) }), url);

		expect(details.renderSkipped?.reason).toBe("incognito_unsupported");
		expect(daemon.calls.map((call) => call.method)).toEqual(["system.status"]);
	});

	it.each([
		[{ code: "unsupported", message: "no", data: { reason: "unsupported_feature" } }, "incognito_unsupported"],
		[{ code: "internal", message: "Allow in incognito is off" }, "incognito_unavailable"],
	] as const)("maps an incognito session.start error to %j", async (error, reason) => {
		const url = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(connectedBrowser(url, { "session.start": () => ({ error }) }));

		const { details } = await fetchWith(createWebfetchTool({ renderer: renderer(daemon) }), url);

		expect(details.renderSkipped?.reason).toBe(reason);
		expect(details.renderSkipped?.detail).toContain(error.message);
	});

	it("maps an unresponsive extension during navigate to browser_unresponsive and still stops the session", async () => {
		const url = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(
			connectedBrowser(url, {
				"tool.navigate": () => ({
					error: { code: "timeout", message: "late", data: { reason: "extension_unresponsive" } },
				}),
			}),
		);

		const { details } = await fetchWith(createWebfetchTool({ renderer: renderer(daemon) }), url);

		expect(details.renderSkipped).toMatchObject({
			reason: "integration_not_connected",
			cause: "browser_unresponsive",
		});
		expect(daemon.calls.at(-1)?.method).toBe("session.stop");
	});

	it("cancels and stops after its own deadline and returns the static text", async () => {
		const url = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(connectedBrowser(url, { "tool.navigate": () => "never" }));
		const tool = createWebfetchTool({ renderer: renderer(daemon) });

		const { details } = await fetchWith(tool, url, "markdown", undefined, 4);

		expect(details.renderSkipped?.reason).toBe("timeout");
		const methods = daemon.calls.map((call) => call.method);
		expect(methods).toContain("cancel");
		expect(methods.at(-1)).toBe("session.stop");
	});

	it("rejects with the abort and still stops the session when the call is aborted mid-render", async () => {
		const url = await serveHtml(APP_SHELL);
		const controller = new AbortController();
		const daemon = await fakeDaemon(
			connectedBrowser(url, {
				"tool.navigate": () => {
					controller.abort(new Error("user cancelled"));
					return "never";
				},
			}),
		);

		await expect(
			fetchWith(createWebfetchTool({ renderer: renderer(daemon) }), url, "markdown", controller.signal),
		).rejects.toThrow("user cancelled");
		expect(daemon.calls.at(-1)?.method).toBe("session.stop");
	});

	it("uses a timed-out navigation's HTML, and reports no_more_text when the render adds nothing", async () => {
		const url = await serveHtml(APP_SHELL);
		const timedOut = await fakeDaemon(
			connectedBrowser(url, {
				"tool.navigate": () => ({ result: { tab_id: 1, url, final_url: url, reached: "timeout" } }),
			}),
		);
		const empty = await fakeDaemon(
			connectedBrowser(url, {
				"tool.get_html": () => ({ result: { html: APP_SHELL, truncated: false, byte_size: 1, tab_id: 1 } }),
			}),
		);

		const used = await fetchWith(createWebfetchTool({ renderer: renderer(timedOut) }), url);
		const unchanged = await fetchWith(createWebfetchTool({ renderer: renderer(empty) }), url);

		expect(used.details.rendered).toBe(true);
		expect(unchanged.details.renderSkipped?.reason).toBe("no_more_text");
	});

	it("never contacts the daemon for a content page, for format html, or with PI_WEBFETCH_BROWSER=0", async () => {
		const article = await serveHtml(ARTICLE);
		const shell = await serveHtml(APP_SHELL);
		const daemon = await fakeDaemon(connectedBrowser(shell));
		const tool = createWebfetchTool({ renderer: renderer(daemon) });

		const content = await fetchWith(tool, article);
		const raw = await fetchWith(tool, shell, "html");
		vi.stubEnv("PI_WEBFETCH_BROWSER", "0");
		const disabled = await fetchWith(tool, shell);

		expect(daemon.connections).toBe(0);
		expect(content.details.renderSkipped).toBeUndefined();
		expect(raw.userText).toBe(APP_SHELL);
		expect(raw.details.renderSkipped).toBeUndefined();
		expect(disabled.details.renderSkipped?.reason).toBe("disabled");
	});

	it("keeps at most two browser sessions open at once", async () => {
		const url = await serveHtml(APP_SHELL);
		const held: Array<() => void> = [];
		let onHeld: (() => void) | undefined;
		const heldCount = (count: number) =>
			new Promise<void>((resolve) => {
				const check = (): void => {
					if (held.length >= count) resolve();
					else onHeld = check;
				};
				check();
			});
		const daemon = await fakeDaemon(
			connectedBrowser(url, {
				"tool.navigate": () =>
					new Promise<Reply>((resolve) => {
						held.push(() => resolve({ result: { tab_id: 1, url, final_url: url, reached: "networkidle" } }));
						onHeld?.();
					}),
			}),
		);
		const tool = createWebfetchTool({ renderer: renderer(daemon, { statusTimeoutMs: 2_000 }) });

		const fetches = [fetchWith(tool, url), fetchWith(tool, url), fetchWith(tool, url)];
		const settledEarly = Promise.race(fetches).then((result) => {
			throw new Error(`a fetch settled while sessions were held: ${JSON.stringify(result.details.renderSkipped)}`);
		});
		await Promise.race([heldCount(2), settledEarly]);
		const liveWhileTwoHeld = daemon.liveSessions;
		for (const resume of held.splice(0)) resume();
		settledEarly.catch(() => {});
		await heldCount(1);
		for (const resume of held.splice(0)) resume();
		const results = await Promise.all(fetches);

		expect(liveWhileTwoHeld).toBe(2);
		expect(daemon.maxLiveSessions).toBe(2);
		expect(results.every((result) => result.details.rendered)).toBe(true);
	});
});
