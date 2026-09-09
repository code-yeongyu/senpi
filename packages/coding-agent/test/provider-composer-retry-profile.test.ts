import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { KIMI_CODE_RETRY_PROFILE } from "@earendil-works/pi-ai/utils/retry-profile/profiles";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir !== undefined) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function compose(base: Parameters<typeof composeModelProvider>[1]) {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-composer-retry-profile-"));
	const modelsPath = join(tempDir, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
	return composeModelProvider("test-provider", base, ModelConfig.loadSync(modelsPath), undefined);
}

function createBase(withProfile: boolean) {
	const api = {
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
	return createProvider({
		id: "test-provider",
		auth: { apiKey: { name: "Test API key", resolve: async () => undefined } },
		models: [],
		api,
		...(withProfile ? { retryPolicy: KIMI_CODE_RETRY_PROFILE } : {}),
	});
}

describe("composed provider retryPolicy forwarding", () => {
	it("preserves a provider-declared retry profile through composition", () => {
		const composed = compose(createBase(true));
		expect(composed.retryPolicy?.id).toBe("kimi-code");
	});

	it("composed provider without a profile stays undefined", () => {
		const composed = compose(createBase(false));
		expect(composed.retryPolicy).toBeUndefined();
	});
});
