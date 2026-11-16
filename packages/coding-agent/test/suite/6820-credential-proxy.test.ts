// senpi#6820: a credential declared in the user's global `credentialProxy` settings never reaches an agent-spawned
// process. The child gets a placeholder and a base URL routed through the loopback proxy, which adds the header for
// the one declared origin. Security contract: the value must not appear in a child environment, in a refusal, or in
// an upstream-failure response, and the proxy must never send it anywhere but the declared origin.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { createBashTool } from "../../src/core/tools/bash.ts";
import { getShellEnv } from "../../src/utils/shell.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "./harness.ts";

const SECRET = "sk-6820-not-a-real-key-7f3a9c";
const posix = process.platform !== "win32";

interface Upstream {
	readonly origin: string;
	readonly seen: { path: string; headers: IncomingHttpHeaders }[];
	readonly server: Server;
}

const harnesses: Harness[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await emitSessionShutdownEvent(harness.getExtensionRunner(), { type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	vi.unstubAllEnvs();
});

async function upstream(
	respond: (path: string) => { status: number; headers?: Record<string, string>; body: string },
): Promise<Upstream> {
	const seen: Upstream["seen"] = [];
	const server = createServer((request, response) => {
		const path = request.url ?? "";
		seen.push({ path, headers: request.headers });
		const reply = respond(path);
		response.writeHead(reply.status, reply.headers ?? { "content-type": "text/plain" });
		response.end(reply.body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

async function start(credentials: unknown[]): Promise<{ harness: Harness; notices: string[] }> {
	vi.stubEnv("TEST_CRED_6820", SECRET);
	vi.stubEnv("TEST_CRED_6820_COPY", SECRET);
	const harness = await createHarness({
		extensionFactories: [
			...builtinExtensions.filter((entry) => entry.id === "credential-proxy").map((entry) => entry.factory),
			(pi) => pi.registerTool({ ...createBashTool(process.cwd()), name: "agent_bash" }),
		],
	});
	harnesses.push(harness);
	const agentDir = join(harness.tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ credentialProxy: { credentials } }));
	const notices: string[] = [];
	const ui = createTestUiContext();
	await harness.session.bindExtensions({ uiContext: { ...ui, notify: (message: string) => notices.push(message) } });
	return { harness, notices };
}

const declaration = (origin: string, extra: Record<string, unknown> = {}) => ({
	env: "TEST_CRED_6820",
	origin,
	baseUrlEnv: "TEST_CRED_6820_BASE_URL",
	...extra,
});

describe.runIf(posix)("credential injection proxy (senpi#6820)", () => {
	it("withholds a declared credential, and any copy of its value, from the agent bash tool's child", async () => {
		const { harness } = await start([declaration("https://api.example.invalid")]);
		const result = await harness.session.executeTool("agent_bash", {
			command: `printf '%s|%s' "\${TEST_CRED_6820-unset}" "\${TEST_CRED_6820_COPY-unset}"; env | grep -c '${SECRET}' || true`,
		});
		const text = getMessageText(result);
		expect(text).not.toContain(SECRET);
		expect(text).toContain("senpi-credential-proxy-placeholder|senpi-credential-proxy-placeholder");
		expect(getShellEnv().TEST_CRED_6820).toBe("senpi-credential-proxy-placeholder");
	});

	it("lets a child call the declared origin through its base URL, with the header injected and a client copy replaced", async () => {
		const api = await upstream(() => ({ status: 200, body: "upstream-ok" }));
		const { harness } = await start([declaration(api.origin)]);
		const fetchScript = `fetch(process.env.TEST_CRED_6820_BASE_URL + "/v1/models?x=1", { headers: { authorization: "Bearer forged" } }).then((r) => r.text()).then((t) => process.stdout.write(t))`;
		const result = await harness.session.executeTool("agent_bash", {
			command: `"${process.execPath}" -e '${fetchScript}'`,
		});
		expect(getMessageText(result)).toBe("upstream-ok");
		expect(api.seen).toHaveLength(1);
		expect(api.seen[0]?.path).toBe("/v1/models?x=1");
		expect(api.seen[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
	});

	it("refuses a wrong capability, an undeclared route, a path outside pathPrefixes and an encoded traversal", async () => {
		const api = await upstream(() => ({ status: 200, body: "should-not-be-reached" }));
		await start([declaration(api.origin, { pathPrefixes: ["/v1"] })]);
		const route = getShellEnv().TEST_CRED_6820_BASE_URL ?? "";
		const base = new URL(route);
		const [, capability] = base.pathname.split("/");
		const attempts = [
			`${base.origin}/${"A".repeat(capability?.length ?? 43)}/TEST_CRED_6820/v1/models`,
			`${base.origin}/${capability}/HOME/v1/models`,
			`${route}/admin/keys`,
			`${route}/v1/%2e%2e/admin`,
			`${route}/v1/../admin`,
		];
		for (const url of attempts) {
			const response = await fetch(url);
			const body = await response.text();
			expect(response.status, url).toBe(403);
			expect(body).not.toContain(SECRET);
		}
		expect(api.seen).toHaveLength(0);
	});

	it("returns an upstream redirect instead of following it, so the header never reaches another host", async () => {
		const elsewhere = await upstream(() => ({ status: 200, body: "elsewhere" }));
		const api = await upstream(() => ({ status: 302, headers: { location: `${elsewhere.origin}/steal` }, body: "" }));
		await start([declaration(api.origin)]);
		const response = await fetch(`${getShellEnv().TEST_CRED_6820_BASE_URL}/v1/models`, { redirect: "manual" });
		expect(response.status).toBe(302);
		expect(elsewhere.seen).toHaveLength(0);
	});

	it("never echoes the value when the upstream call fails, in the response or a notice", async () => {
		const closed = await upstream(() => ({ status: 200, body: "" }));
		const origin = closed.origin;
		await new Promise<void>((resolve) => closed.server.close(() => resolve()));
		servers.splice(servers.indexOf(closed.server), 1);
		const { notices } = await start([declaration(origin)]);
		const response = await fetch(`${getShellEnv().TEST_CRED_6820_BASE_URL}/v1/models`);
		const body = await response.text();
		expect(response.status).toBe(502);
		expect(body).not.toContain(SECRET);
		expect(notices.join("\n")).not.toContain(SECRET);
	});

	it("withholds a credential whose declaration is invalid, without proxying it", async () => {
		const { notices } = await start([{ env: "TEST_CRED_6820", origin: "http://api.example.invalid" }]);
		const env = getShellEnv();
		expect(env.TEST_CRED_6820).toBe("senpi-credential-proxy-placeholder");
		expect(env.TEST_CRED_6820_BASE_URL).toBeUndefined();
		expect(notices.some((notice) => notice.includes("TEST_CRED_6820") && notice.includes("withheld"))).toBe(true);
	});

	it("leaves the environment untouched once the session ends", async () => {
		const { harness } = await start([declaration("https://api.example.invalid")]);
		expect(getShellEnv().TEST_CRED_6820).toBe("senpi-credential-proxy-placeholder");
		await emitSessionShutdownEvent(harness.getExtensionRunner(), { type: "session_shutdown", reason: "quit" });
		expect(getShellEnv().TEST_CRED_6820).toBe(SECRET);
	});
});
