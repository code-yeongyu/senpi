/**
 * senpi#3403 (sisyphuslabs/omo-desktop-app#2465): "Allow always" on a tool without its own parser
 * remembered only the exact argument, so a browser or MCP tool asked again for the next URL or
 * input. A wider option covers that: per DOMAIN for a URL argument (never tool-wide: that would mean
 * "go anywhere"), tool-wide for a free `input` argument, and nothing wider for a command or path.
 */
import { afterEach, describe, expect, it } from "vitest";
import { urlOriginAlias, widerAlwaysScope } from "../../src/core/extensions/builtin/permission-system/always-scope.ts";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { closeLiveHosts, createLiveHost, type LivePermissionHost } from "./live-permission-host.ts";

afterEach(closeLiveHosts);

/** Runs one call, answers its prompt with `answer` (by exact label), returns the options shown. */
async function callAnswering(host: LivePermissionHost, tool: string, input: Record<string, unknown>, answer: string) {
	const run = host.runProbe(tool, input);
	const prompt = await host.waitForPrompt();
	expect(prompt.options).toContain(answer);
	prompt.resolve(answer);
	await run;
	return prompt.options;
}

describe("a wider Allow always for tools without a parser (#3403)", () => {
	it("a URL tool offers this DOMAIN: same domain stops asking, another domain asks again", async () => {
		// given an ask-preset session and a URL-shaped tool with no parser
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		// when the first URL is answered with the domain scope
		const options = await callAnswering(
			host,
			"fetch_fixture",
			{ url: "https://example.invalid/a" },
			"Allow fetch_fixture on example.invalid always in this project",
		);
		expect(options).not.toContain("Allow fetch_fixture always in this project");

		// then another URL on that domain runs without a prompt
		await host.runProbe("fetch_fixture", { url: "https://example.invalid/b?q=1" });
		expect(host.prompts()).toBe(1);
		expect(host.toolResultIsError("fetch_fixture")).toBe(false);

		// and a look-alike or a different domain still asks
		const lookAlike = host.runProbe("fetch_fixture", { url: "https://example.invalid.evil.test/" });
		(await host.waitForPrompt()).resolve("Deny");
		await lookAlike;
		expect(host.prompts()).toBe(2);
	}, 30_000);

	it("a second open session in the same project stops asking for that domain too", async () => {
		const first = await createLiveHost({ preset: "ask" });
		await first.bind();
		const second = await createLiveHost({ preset: "ask", shareHostWith: first });
		await second.bind();

		await callAnswering(
			first,
			"fetch_fixture",
			{ url: "https://example.invalid/a" },
			"Allow fetch_fixture on example.invalid always in this project",
		);

		await second.runProbe("fetch_fixture", { url: "https://example.invalid/other" });
		expect(second.prompts()).toBe(0);
		expect(second.toolResultIsError("fetch_fixture")).toBe(false);
	}, 30_000);

	it("a tool with a free input argument offers the tool for this project", async () => {
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		await callAnswering(host, "query_fixture", { input: "first" }, "Allow query_fixture always in this project");

		await host.runProbe("query_fixture", { input: "something else" });
		expect(host.prompts()).toBe(1);
	}, 30_000);

	it("a URL whose host is a wildcard never offers a domain scope", async () => {
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		const run = host.runProbe("fetch_fixture", { url: "https://*.example.invalid/a" });
		const prompt = await host.waitForPrompt();
		expect(prompt.options.filter((option) => option.endsWith("always in this project"))).toEqual([]);
		prompt.resolve("Deny");
		await run;
	}, 30_000);

	it("a command-shaped tool never offers a wider scope", async () => {
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		const run = host.runProbe("shell_fixture", { command: "echo one" });
		const prompt = await host.waitForPrompt();
		expect(prompt.options.filter((option) => option.endsWith("always in this project"))).toEqual([]);
		prompt.resolve("Deny");
		await run;
	}, 30_000);
});

describe("widerAlwaysScope (#3403)", () => {
	/** Decides `url` under the domain grant offered for `grantUrl`, as the permission system does. */
	const allowedUnder = (grantUrl: string, url: string): boolean => {
		const scope = widerAlwaysScope("fetch_fixture", "url", grantUrl);
		if (scope === undefined) throw new Error(`no domain scope for ${grantUrl}`);
		const rules = scope.patterns.map((pattern) => ({
			permission: "fetch_fixture",
			pattern,
			action: "allow" as const,
		}));
		const alias = urlOriginAlias(url);
		return evaluate("fetch_fixture", alias === undefined ? [url] : [url, alias], rules).action === "allow";
	};

	it("allows only the grant's own origin, written any way the URL parser normalizes it", () => {
		const grant = "https://example.invalid/a";
		expect(allowedUnder(grant, "https://example.invalid")).toBe(true);
		expect(allowedUnder(grant, "https://example.invalid/deep/path")).toBe(true);
		expect(allowedUnder(grant, "https://example.invalid/?x=1")).toBe(true);
		expect(allowedUnder(grant, "https://example.invalid?x=1")).toBe(true);
		expect(allowedUnder(grant, "https://EXAMPLE.invalid/x")).toBe(true);
		expect(allowedUnder(grant, "https://example.invalid:443/x")).toBe(true);
	});

	it("refuses look-alike hosts, other ports, other schemes and paths that mention the host", () => {
		const grant = "https://example.invalid/a";
		expect(allowedUnder(grant, "https://example.invalid.evil.test/")).toBe(false);
		expect(allowedUnder(grant, "https://example.invalid@evil.test/")).toBe(false);
		expect(allowedUnder(grant, "https://evil.test/example.invalid")).toBe(false);
		expect(allowedUnder(grant, "https://evil.test/.example.invalid/x")).toBe(false);
		expect(allowedUnder(grant, "https://example.invalid:8443/")).toBe(false);
		expect(allowedUnder(grant, "http://example.invalid/")).toBe(false);
	});

	it("refuses any raw URL other parsers could read as another host (parser differentials)", () => {
		const grant = "https://example.invalid/a";
		// WHATWG reads these as example.invalid; curl and Python's urlsplit go to evil.test.
		expect(allowedUnder(grant, "https://example.invalid\\@evil.test/")).toBe(false);
		expect(allowedUnder(grant, "https://example.invalid\\.evil.test/")).toBe(false);
		// Userinfo, percent-escapes, whitespace and control characters never get an origin alias.
		expect(allowedUnder(grant, "https://user:pass@example.invalid/x")).toBe(false);
		expect(allowedUnder(grant, "https://example%2Einvalid/x")).toBe(false);
		expect(allowedUnder(grant, " https://example.invalid/x")).toBe(false);
		expect(allowedUnder(grant, "https://example.invalid/x\t")).toBe(false);
		expect(allowedUnder(grant, "https://exa\tmple.invalid/x")).toBe(false);
		expect(allowedUnder(grant, "https://example.invalid\r\n.evil.test/")).toBe(false);
		// Fullwidth letters fold under NFKC in some parsers but not others.
		expect(allowedUnder(grant, "https://ｅxample.invalid/x")).toBe(false);
		// And none of them is offered a domain scope of its own.
		expect(widerAlwaysScope("fetch_fixture", "url", "https://example.invalid\\@evil.test/")).toBeUndefined();
		expect(widerAlwaysScope("fetch_fixture", "url", "https://user@example.invalid/")).toBeUndefined();
	});

	it("never offers a domain scope for a host with glob or regex characters", () => {
		expect(widerAlwaysScope("fetch_fixture", "url", "https://*.example.invalid/a")).toBeUndefined();
		expect(widerAlwaysScope("fetch_fixture", "url", "https://*/a")).toBeUndefined();
		expect(widerAlwaysScope("fetch_fixture", "url", "https://exa[mple.invalid/")).toBeUndefined();
		expect(widerAlwaysScope("fetch_fixture", "url", "https://exa?mple.invalid/")?.label).toBe(
			"Allow fetch_fixture on exa always in this project",
		);
	});

	it("gives an IDN host a scope only when it is written in punycode", () => {
		// Parsers disagree on Unicode hosts (IDNA 2003 vs 2008, NFKC), so the raw Unicode spelling asks.
		expect(widerAlwaysScope("fetch_fixture", "url", "https://bücher.example/a")).toBeUndefined();
		const scope = widerAlwaysScope("fetch_fixture", "url", "https://xn--bcher-kva.example/a");
		expect(scope?.label).toBe("Allow fetch_fixture on xn--bcher-kva.example always in this project");
		expect(allowedUnder("https://xn--bcher-kva.example/a", "https://XN--BCHER-KVA.example/b")).toBe(true);
		expect(allowedUnder("https://xn--bcher-kva.example/a", "https://bücher.example/c")).toBe(false);
	});

	it("refuses IPv6 literals, trailing-dot hosts and an '@' anywhere", () => {
		expect(widerAlwaysScope("fetch_fixture", "url", "https://[::1]/a")).toBeUndefined();
		expect(widerAlwaysScope("fetch_fixture", "url", "https://example.invalid./a")).toBeUndefined();
		expect(allowedUnder("https://example.invalid/a", "https://example.invalid./b")).toBe(false);
		expect(allowedUnder("https://example.invalid/a", "https://example.invalid/path@evil.test")).toBe(false);
	});

	it("keeps a non-default port in the scope and its label", () => {
		expect(widerAlwaysScope("fetch_fixture", "url", "https://example.invalid:8443/a")?.label).toBe(
			"Allow fetch_fixture on example.invalid:8443 always in this project",
		);
		expect(allowedUnder("https://example.invalid:8443/a", "https://example.invalid/")).toBe(false);
	});

	it("offers nothing for a command, a path, a non-http URL or a built-in tool", () => {
		expect(widerAlwaysScope("shell_fixture", "command", "echo hi")).toBeUndefined();
		expect(widerAlwaysScope("tool", "path", "/etc/passwd")).toBeUndefined();
		expect(widerAlwaysScope("tool", "url", "file:///etc/passwd")).toBeUndefined();
		expect(widerAlwaysScope("bash", "input", "x")).toBeUndefined();
	});
});
