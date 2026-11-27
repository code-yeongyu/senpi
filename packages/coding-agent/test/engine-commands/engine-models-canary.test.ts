import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { engine } from "../../src/engine/index.ts";
import { allowNetwork } from "../test-network-env.ts";

const CANARY = "CANARY-7450-d41d8cd98f";

let root: string;
let originalCwd: string;
let server: Server | undefined;

function writeModelsJson(baseUrl: string): void {
	writeFileSync(
		join(getAgentDir(), "models.json"),
		JSON.stringify({
			providers: {
				"canary-7450": {
					baseUrl,
					api: "openai-completions",
					apiKey: `key-${CANARY}`,
					headers: { Authorization: `Bearer ${CANARY}`, "x-tenant": CANARY },
					models: [
						{
							id: "canary-model",
							name: "Canary model",
							baseUrl,
							headers: { Authorization: `Bearer ${CANARY}` },
							reasoning: false,
							input: ["text"],
							contextWindow: 8192,
							maxTokens: 1024,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
}

async function listingServer(): Promise<string> {
	const listening = createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "canary-model" }, { id: "canary-new" }] }));
	});
	server = listening;
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
}

beforeEach(() => {
	allowNetwork();
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-canary-")));
	vi.stubEnv("HOME", root);
	originalCwd = process.cwd();
	process.chdir(root);
});

afterEach(async () => {
	process.chdir(originalCwd);
	vi.unstubAllEnvs();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
	for (const file of ["models.json", "models-store.json"]) rmSync(join(getAgentDir(), file), { force: true });
	rmSync(root, { recursive: true, force: true });
});

describe("no credential leaves through a model listing or discovery (E1a-s finding on models.list)", () => {
	it("lists the model without its headers or base URL", async () => {
		writeModelsJson(`https://user:${CANARY}@models.example.invalid/v1?key=${CANARY}`);
		const listed = await engine.models.list({ pattern: "canary-7450" });

		expect(listed.kind === "ok" && listed.value.models.map((model) => model.id)).toEqual(["canary-model"]);
		expect(listed.kind === "ok" && listed.value.models[0]).not.toHaveProperty("headers");
		expect(listed.kind === "ok" && listed.value.models[0]).not.toHaveProperty("baseUrl");
		expect(JSON.stringify(listed)).not.toContain(CANARY);
	});

	it("discovers without echoing a header or a base URL secret", async () => {
		writeModelsJson(`${await listingServer()}/v1?key=${CANARY}`);
		const discovered = await engine.models.discover({ provider: "canary-7450" });

		expect(discovered.kind).toBe("ok");
		expect(discovered.kind === "ok" && discovered.value.added).toEqual(["canary-new"]);
		expect(JSON.stringify(discovered)).not.toContain(CANARY);
	});

	it("refuses discovery from a base URL with credentials without echoing them", async () => {
		writeModelsJson(`http://user:${CANARY}@127.0.0.1:9/v1`);
		const discovered = await engine.models.discover({ provider: "canary-7450" });

		expect(discovered.kind).toBe("error");
		expect(JSON.stringify(discovered)).not.toContain(CANARY);
	});
});
