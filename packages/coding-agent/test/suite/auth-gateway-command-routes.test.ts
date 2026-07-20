import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthBrokerServer } from "../../src/cli/auth-broker-server.ts";
import { executeAuthGatewayCommand } from "../../src/cli/auth-gateway-cli.ts";
import { AuthBrokerService, SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import { AUTH_BROKER_CAPABILITIES } from "../../src/core/auth-broker-wire-contract.ts";
import { createFauxStreamFn, fauxModel } from "../test-harness.ts";

const brokerToken = "broker-command-routes-token";
const credentialSecret = "faux-provider-key";
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })));
});

describe("auth gateway command provider routes", () => {
	it("proxies chat, Messages, Responses, and Pi requests through the live serve command", async () => {
		// Given: a broker-backed faux credential and one explicitly authorized faux model.
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-auth-gateway-routes-"));
		directories.push(agentDir);
		const faux = createFauxStreamFn(["gateway response"]);
		const vault = SqliteCredentialVault.open(join(agentDir, "broker.sqlite"));
		vault.upsertCredential({
			createdAt: "2026-07-11T00:00:00.000Z",
			credentialId: "faux-account",
			identityKey: "operator:faux",
			material: { apiKey: credentialSecret, type: "api_key" },
			pool: { provider: "faux", type: "api_key" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		const broker = new AuthBrokerService(vault, [
			{ authentication: brokerToken, capabilities: Object.values(AUTH_BROKER_CAPABILITIES), trustedGateway: true },
		]);
		const server = await startAuthBrokerServer({ bind: { host: "127.0.0.1", port: 0 }, broker, version: "test" });
		try {
			const responses: Response[] = [];

			// When: each supported provider route is called through the real CLI listener.
			const result = await executeAuthGatewayCommand(
				["auth-gateway", "serve", "--bind", "127.0.0.1:0", `--model=faux/${fauxModel.id}`],
				{
					agentDir,
					brokerToken,
					brokerUrl: server.url,
					onGatewayStarted: async (handle) => {
						const authorization = `Bearer ${await gatewayBearer(agentDir)}`;
						responses.push(
							await providerRequest(handle.url, authorization, "/v1/chat/completions", {
								messages: [{ content: "chat", role: "user" }],
								model: fauxModel.id,
								stream: true,
							}),
							await providerRequest(handle.url, authorization, "/v1/messages", {
								max_tokens: 64,
								messages: [{ content: "messages", role: "user" }],
								model: fauxModel.id,
							}),
							await providerRequest(handle.url, authorization, "/v1/responses", {
								input: "responses",
								model: fauxModel.id,
							}),
							await providerRequest(handle.url, authorization, "/v1/pi/stream", {
								context: { messages: [{ content: "pi", role: "user", timestamp: 1 }] },
								modelId: fauxModel.id,
								stream: true,
							}),
						);
					},
					resolveModel: (provider, modelId) =>
						provider === fauxModel.provider && modelId === fauxModel.id ? fauxModel : undefined,
					streamSimple: faux.streamFn,
				},
			);

			// Then: every route succeeds with its protocol shape and no credential material is returned.
			expect(result?.exitCode).toBe(0);
			expect(responses).toHaveLength(4);
			const bodies = await Promise.all(responses.map(async (response) => response.text()));
			expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
			expect(responses[0]?.headers.get("content-type")).toContain("text/event-stream");
			expect(bodies[0]).toContain("[DONE]");
			expect(bodies[1]).toContain('"type":"message"');
			expect(bodies[2]).toContain('"object":"response"');
			expect(responses[3]?.headers.get("content-type")).toContain("text/event-stream");
			expect(bodies[3]).toContain('"type":"done"');
			expect(JSON.stringify(bodies)).not.toContain(credentialSecret);
			expect(faux.state.callCount).toBe(4);
		} finally {
			await server.close();
			vault.close();
		}
	});

	it("cancels provider work when a live streaming client disconnects", async () => {
		// Given: a live command route whose faux provider waits for request cancellation.
		const agentDir = await mkdtemp(join(tmpdir(), "senpi-auth-gateway-disconnect-"));
		directories.push(agentDir);
		const vault = SqliteCredentialVault.open(join(agentDir, "broker.sqlite"));
		vault.upsertCredential({
			createdAt: "2026-07-11T00:00:00.000Z",
			credentialId: "faux-disconnect-account",
			identityKey: "operator:faux-disconnect",
			material: { apiKey: credentialSecret, type: "api_key" },
			pool: { provider: "faux", type: "api_key" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		const broker = new AuthBrokerService(vault, [
			{ authentication: brokerToken, capabilities: Object.values(AUTH_BROKER_CAPABILITIES), trustedGateway: true },
		]);
		const server = await startAuthBrokerServer({ bind: { host: "127.0.0.1", port: 0 }, broker, version: "test" });
		let providerEntered: (() => void) | undefined;
		let providerAborted: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			providerEntered = resolve;
		});
		const aborted = new Promise<void>((resolve) => {
			providerAborted = resolve;
		});
		try {
			// When: an authenticated streaming request disconnects after provider work begins.
			const result = await executeAuthGatewayCommand(
				["auth-gateway", "serve", "--bind", "127.0.0.1:0", `--model=faux/${fauxModel.id}`],
				{
					agentDir,
					brokerToken,
					brokerUrl: server.url,
					onGatewayStarted: async (handle) => {
						const controller = new AbortController();
						const request = providerRequest(
							handle.url,
							`Bearer ${await gatewayBearer(agentDir)}`,
							"/v1/chat/completions",
							{ messages: [{ content: "disconnect", role: "user" }], model: fauxModel.id, stream: true },
							controller.signal,
						).catch(() => undefined);
						await entered;
						controller.abort();
						await aborted;
						await request;
					},
					resolveModel: () => fauxModel,
					streamSimple: (_model, _context, options) => {
						const stream = createAssistantMessageEventStream();
						providerEntered?.();
						options?.signal?.addEventListener(
							"abort",
							() => {
								const error = fauxAssistantMessage("", { stopReason: "aborted" });
								stream.push({ error, reason: "aborted", type: "error" });
								stream.end();
								providerAborted?.();
							},
							{ once: true },
						);
						return stream;
					},
				},
			);

			// Then: cancellation reaches the provider signal before command shutdown.
			expect(result?.exitCode).toBe(0);
			await expect(aborted).resolves.toBeUndefined();
		} finally {
			await server.close();
			vault.close();
		}
	});
});

async function providerRequest(
	baseUrl: string,
	authorization: string,
	pathname: string,
	body: Readonly<Record<string, unknown>>,
	signal?: AbortSignal,
): Promise<Response> {
	return fetch(`${baseUrl}${pathname}`, {
		body: JSON.stringify(body),
		headers: { authorization, "content-type": "application/json" },
		method: "POST",
		signal,
	});
}

async function gatewayBearer(agentDir: string): Promise<string> {
	return (await readFile(join(agentDir, "auth-gateway.token"), "utf8")).trim();
}
