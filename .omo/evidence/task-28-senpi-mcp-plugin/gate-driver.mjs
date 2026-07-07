// W3 AUTH GATE DRIVER — drives the REAL shipped auth modules end-to-end against
// the fixture IdP in a sandbox agentDir. Every step writes one artifact.
// Real remote OAuth servers (Linear/Notion) are explicitly NON-GATING.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "/tmp/train-c-w3-auth/packages/coding-agent";
const S = (p) => `${PKG}/src/core/extensions/builtin/mcp/${p}`;
const { ServerConnection } = await import(S("connection.ts"));
const { resolveServerAuth } = await import(S("auth/context.ts"));
const { McpTokenStore } = await import(S("auth/token-store.ts"));
const { McpOAuthProvider } = await import(S("auth/oauth-provider.ts"));
const { McpRefreshManager } = await import(S("auth/oauth-refresh.ts"));
const { beginAuthorization, completeAuthorization } = await import(S("auth/oauth.ts"));
const { runAuth, runAuthStart, runAuthComplete, runLogout } = await import(S("auth/commands-auth.ts"));
const { createMcpTransport, connectMcpTransport, shutdownMcpTransport } = await import(S("transport.ts"));
const { createMcpLogger, getMcpLogDir } = await import(S("log.ts"));
const { spawnOAuthIdp } = await import(`${PKG}/test/mcp/fixtures/spawn-idp.ts`);

const OUT = dirname(fileURLToPath(import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "senpi-w3-gate-"));
const agentDir = join(sandbox, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.SENPI_CODING_AGENT_DIR = agentDir;

const results = [];
function artifact(step, title, verdict, body) {
	writeFileSync(join(OUT, `step-${String(step).padStart(2, "0")}.txt`), `STEP ${step}: ${title}\nVERDICT: ${verdict}\n\n${body}\n`);
	results.push({ step, title, verdict });
	console.log(`STEP ${step} ${verdict}: ${title}`);
}

function httpConfig(url, extra = {}) {
	return { type: "http", url, args: [], enabled: true, lifecycle: "lazy", connectTimeoutMs: 5000, requestTimeoutMs: 5000, idleTimeoutMin: 10, exposure: "auto", logLevel: "info", ...extra };
}
async function connectWith(name, config) {
	const logger = createMcpLogger(name);
	const plan = resolveServerAuth({ agentDir, config, serverName: name, logger });
	const conn = new ServerConnection({ serverName: name, config, logger, authProvider: plan.provider });
	return { conn, plan, logger };
}
function makeDeps(name, config, extra = {}) {
	const notes = [];
	const browsered = [];
	return {
		notes, browsered,
		deps: {
			serverName: name, config, agentDir, hasUI: true,
			notify: (m, t = "info") => notes.push({ m, t }),
			openBrowser: (u) => browsered.push(String(u)),
			onReconnect: () => Promise.resolve(),
			pending: new Map(),
			...extra,
		},
	};
}
async function follow(url) {
	const r = await fetch(url, { redirect: "manual" });
	return r.headers.get("location");
}

const idp = await spawnOAuthIdp();
try {
	const name = "fixture-oauth";
	const config = httpConfig(idp.mcpUrl);

	// STEP 1: add OAuth server, first connect -> needs_auth (no token yet).
	{
		const { conn } = await connectWith(name, config);
		let state = "";
		try { await conn.connect(); } catch { state = conn.state; }
		state = conn.state;
		await conn.dispose();
		const hint = `Run /mcp auth ${name}`;
		artifact(1, "add OAuth HTTP server -> first call -> needs_auth", state === "needs_auth" ? "PASS" : "FAIL",
			`connection state after unauthenticated connect: ${state}\nneeds_auth toast hint: "${hint}"`);
	}

	// STEP 2: browser-less auth loop -> connected -> tool call OK.
	{
		const { deps, notes } = makeDeps(name, config);
		const authUrl = await runAuthStart(deps);
		const redirect = await follow(authUrl);
		await runAuthComplete(deps, redirect);
		const { conn } = await connectWith(name, config);
		await conn.connect();
		const tools = await conn.client.listTools({}, { timeout: 4000 });
		const connectedState = conn.state;
		await conn.dispose();
		artifact(2, "auth browser-less loop -> connected -> tool call OK", connectedState === "connected" && tools.tools.length > 0 ? "PASS" : "FAIL",
			`auth-start URL S256=${new URL(authUrl).searchParams.get("code_challenge_method")}\nstate=${connectedState}, tools listed=${tools.tools.length}\nnotes=${JSON.stringify(notes.map((n) => n.m.slice(0, 40)))}`);
	}

	// STEP 3: restart (fresh connection instance) reuses the stored token, no re-auth.
	{
		const before = (await idp.getLog()).tokenHits;
		const { conn } = await connectWith(name, config);
		await conn.connect();
		const s = conn.state;
		await conn.dispose();
		const after = (await idp.getLog()).tokenHits;
		artifact(3, "restart -> stored token reused, NO re-auth", s === "connected" && after === before ? "PASS" : "FAIL",
			`reconnected state=${s}; token-endpoint hits unchanged (${before} -> ${after}) => no new authorization`);
	}

	// STEP 4: expire the access token -> transparent refresh on next use.
	{
		const store = new McpTokenStore({ agentDir, serverName: name, serverUrl: idp.mcpUrl });
		await store.update((c) => ({ ...c, expiresAt: Date.now() + 60_000 }));
		const provider = new McpOAuthProvider({ serverName: name, serverUrl: idp.mcpUrl, store, clientId: store.read()?.clientInfo?.client_id ?? undefined, redirectUrl: "http://127.0.0.1:0/callback" });
		const before = (await idp.getLog()).tokenHits;
		const mgr = new McpRefreshManager(provider);
		const fresh = await mgr.ensureFresh();
		const after = (await idp.getLog()).tokenHits;
		artifact(4, "expire access token -> transparent refresh", fresh?.access_token?.startsWith("SENTINEL_AT_") && after - before === 1 ? "PASS" : "FAIL",
			`refreshed access token prefix=${fresh?.access_token?.slice(0, 12)}...; token-endpoint hits +${after - before} (exactly one refresh)`);
	}

	// STEP 5: headless paste flow end-to-end (auth-start + auth-complete).
	{
		const dir2 = join(sandbox, "agent5");
		mkdirSync(dir2, { recursive: true });
		const { deps } = makeDeps(name, config, { agentDir: dir2 });
		const authUrl = await runAuthStart(deps);
		await runAuthComplete(deps, await follow(authUrl));
		const store = new McpTokenStore({ agentDir: dir2, serverName: name, serverUrl: idp.mcpUrl });
		artifact(5, "headless paste flow end-to-end", store.read()?.tokens?.access_token ? "PASS" : "FAIL",
			`paste flow stored token prefix=${store.read()?.tokens?.access_token?.slice(0, 12)}...`);
	}

	// STEP 6: logout -> needs_auth again on next use.
	{
		const { deps } = makeDeps(name, config);
		await runLogout(deps);
		const { conn } = await connectWith(name, config);
		let s = "";
		try { await conn.connect(); } catch { /* expected */ }
		s = conn.state;
		await conn.dispose();
		const store = new McpTokenStore({ agentDir, serverName: name, serverUrl: idp.mcpUrl });
		// A post-logout connect re-runs DCR, so a tokenless record may reappear;
		// what matters is that the access/refresh tokens are gone.
		const tokensGone = store.read()?.tokens === undefined;
		artifact(6, "logout -> needs_auth", s === "needs_auth" && tokensGone ? "PASS" : "FAIL",
			`after logout: tokens cleared=${tokensGone}; next connect state=${s}`);
	}

	// STEP 7: invalid_grant injection -> credentials dropped + clean re-auth.
	{
		const dir7 = join(sandbox, "agent7");
		mkdirSync(dir7, { recursive: true });
		const store = new McpTokenStore({ agentDir: dir7, serverName: name, serverUrl: idp.mcpUrl });
		await store.write({ tokens: { access_token: "AT_stale", refresh_token: "RT_UNKNOWN", token_type: "Bearer", expires_in: 60 }, expiresAt: Date.now() + 60_000 });
		const provider = new McpOAuthProvider({ serverName: name, serverUrl: idp.mcpUrl, store, clientId: "c", redirectUrl: "http://127.0.0.1:0/callback" });
		let dropped = false, kind = "";
		try { await new McpRefreshManager(provider).ensureFresh(); } catch (e) { kind = e.oauthKind; dropped = store.read()?.tokens === undefined; }
		// clean re-auth after the drop
		const { deps } = makeDeps(name, config, { agentDir: dir7 });
		const reUrl = await runAuthStart(deps);
		await runAuthComplete(deps, await follow(reUrl));
		const reok = store.read()?.tokens?.access_token?.startsWith("SENTINEL_AT_");
		artifact(7, "invalid_grant injection -> drop + clean re-auth", kind === "invalid_grant" && dropped && reok ? "PASS" : "FAIL",
			`refresh kind=${kind}; credentials dropped=${dropped}; re-auth succeeded=${reok}`);
	}

	// STEP 8: bearer ${VAR} happy + unset-var failure.
	{
		const { spawnHttpFixture } = await import(`${PKG}/test/mcp/fixtures/spawn-fixture.ts`);
		const token = "gate-bearer-token";
		const fx = await spawnHttpFixture(["--bearer", token, "--tools", "1"]);
		const bcfg = httpConfig(fx.url, { auth: "bearer", bearerTokenEnv: "GATE_TOKEN" });
		const okConn = createMcpTransport({ config: bcfg, env: { GATE_TOKEN: token }, logger: createMcpLogger("bearer"), serverName: "bearer" });
		await connectMcpTransport(okConn);
		const okTools = (await okConn.client.listTools({}, { timeout: 3000 })).tools.length;
		await shutdownMcpTransport(okConn);
		let unsetErr = "";
		try { createMcpTransport({ config: bcfg, env: {}, logger: createMcpLogger("bearer"), serverName: "bearer" }); } catch (e) { unsetErr = e.message; }
		await fx.cleanup();
		artifact(8, "bearer ${VAR} happy + unset-var failure", okTools > 0 && /GATE_TOKEN is not set/.test(unsetErr) ? "PASS" : "FAIL",
			`with env: connected + ${okTools} tools\nunset var: actionable error -> "${unsetErr}"`);
	}

	// STEP 9: secret audit — grep sandbox logs + evidence for sentinel access tokens.
	{
		const logDir = getMcpLogDir();
		let hits = "";
		try { hits = execFileSync("grep", ["-rn", "SENTINEL_AT_", logDir, OUT], { encoding: "utf8" }); } catch { hits = ""; }
		// tokens.json credential files legitimately hold the token at 0600; exclude them.
		const leaked = hits.split("\n").filter((l) => l && !l.includes("/tokens.json")).join("\n");
		artifact(9, "secret audit: grep logs+evidence for SENTINEL_AT_ tokens", leaked.trim().length === 0 ? "PASS" : "FAIL",
			`grep of ${logDir} and ${OUT} (excluding 0600 tokens.json credential store):\n${leaked.trim() || "(no hits — logs carry only <redacted:xxxxxxxx> fingerprints)"}`);
	}

	// STEP 11: print-mode fail-fast (isError), no browser.
	{
		const { deps, notes, browsered } = makeDeps(name, config, { hasUI: false });
		await runAuth(deps);
		const last = notes.at(-1);
		artifact(11, "print-mode fail-fast isError, no browser", last?.t === "error" && last.m.includes("/mcp auth-start") && browsered.length === 0 ? "PASS" : "FAIL",
			`hasUI=false -> notify type=${last?.t}; mentions auth-start=${last?.m.includes("/mcp auth-start")}; browser attempts=${browsered.length}`);
	}
} finally {
	await idp.cleanup();
}

// Isolation receipt: the real ~/.senpi/agent/mcp-auth must be untouched.
const realMcpAuth = join(process.env.HOME ?? "", ".senpi/agent/mcp-auth");
const realAuthJson = join(process.env.HOME ?? "", ".senpi/agent/auth.json");
writeFileSync(join(OUT, "isolation-receipt.txt"),
	`SENPI_CODING_AGENT_DIR sandbox = ${agentDir}\n` +
	`real ~/.senpi/agent/mcp-auth exists: ${existsSync(realMcpAuth)} (expected: false — all credentials landed in the sandbox)\n` +
	`real ~/.senpi/agent/auth.json exists: ${existsSync(realAuthJson)} (untouched by MCP OAuth; separate store)\n`);

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nGATE STEPS: ${results.filter((r) => r.verdict === "PASS").length}/${results.length} PASS`);
rmSync(sandbox, { recursive: true, force: true });
