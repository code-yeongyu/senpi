import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runModelsDiscoverCommand } from "../../src/cli/models-command.ts";
import { getAgentDir, getModelsPath } from "../../src/config.ts";
import { type ListingServer, readProviderModels, startListingServer } from "./models-discover-support.ts";

// senpi#2196: `senpi models discover` through its CLI entry, against the quarantined agent dir.
describe("senpi models discover (CLI)", () => {
	let server: ListingServer;
	let printed: string[];
	let previousModelsJson: string | undefined;

	beforeEach(async () => {
		mkdirSync(getAgentDir(), { recursive: true });
		previousModelsJson = existsSync(getModelsPath()) ? readFileSync(getModelsPath(), "utf-8") : undefined;
		server = await startListingServer({ data: [{ id: "tenant-model" }] });
		printed = [];
		const capture = (...parts: unknown[]) => {
			printed.push(parts.map(String).join(" "));
		};
		vi.spyOn(console, "log").mockImplementation(capture);
		vi.spyOn(console, "error").mockImplementation(capture);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await server.close();
		if (previousModelsJson === undefined) rmSync(getModelsPath(), { force: true });
		else writeFileSync(getModelsPath(), previousModelsJson);
	});

	function writeProvider(provider: Record<string, unknown>): void {
		writeFileSync(getModelsPath(), JSON.stringify({ providers: { review: provider } }, null, 2));
	}

	// review B4: a keyless provider's configured headers still reach the listing request.
	it("sends a keyless provider's configured headers", async () => {
		server.requiredHeader = { name: "X-Tenant", value: "review-tenant" };
		writeProvider({ baseUrl: server.baseUrl, api: "openai-completions", headers: { "X-Tenant": "review-tenant" } });

		const exitCode = await runModelsDiscoverCommand(["review"]);

		expect(printed.join("\n")).toContain("tenant-model");
		expect(exitCode).toBe(0);
		expect(server.requests.at(-1)?.headers["x-tenant"]).toBe("review-tenant");
		expect(readProviderModels(readFileSync(getModelsPath(), "utf-8"), "review")).toEqual([{ id: "tenant-model" }]);
	});

	// review B5: the printed report never carries a query secret from the configured URL.
	it("prints the listing URL with query values redacted", async () => {
		writeProvider({ baseUrl: `${server.baseUrl}?api_key=dummy-token`, api: "openai-completions" });

		const exitCode = await runModelsDiscoverCommand(["review"]);

		expect(exitCode).toBe(0);
		expect(printed.join("\n")).toContain("/v1/models?api_key=<redacted>");
		expect(printed.join("\n")).not.toContain("dummy-token");
	});
});
