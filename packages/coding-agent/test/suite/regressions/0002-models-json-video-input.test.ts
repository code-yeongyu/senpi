import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../../../src/core/model-config.ts";

const VIDEO_INPUT = ["text", "image", "video"] as const;

function writeModelsJson(dir: string, payload: unknown): string {
	const path = join(dir, "models.json");
	writeFileSync(path, `${JSON.stringify(payload)}\n`, "utf-8");
	return path;
}

describe("models.json video input modality", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "models-json-video-input-"));
		dirs.push(dir);
		return dir;
	}

	it("accepts video in a models[] entry", () => {
		const path = writeModelsJson(tempDir(), {
			providers: {
				"test-video": {
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					models: [{ id: "video-model", input: [...VIDEO_INPUT] }],
				},
			},
		});

		const config = ModelConfig.loadSync(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProviderIds()).toContain("test-video");
		const provider = config.getProvider("test-video");
		expect(provider).toBeDefined();
		expect(provider?.models?.[0]?.id).toBe("video-model");
		expect(provider?.models?.[0]?.input).toEqual(["text", "image", "video"]);
	});

	it("accepts video in a modelOverrides entry", () => {
		const path = writeModelsJson(tempDir(), {
			providers: {
				"test-video": {
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					modelOverrides: {
						"video-model": { input: [...VIDEO_INPUT] },
					},
				},
			},
		});

		const config = ModelConfig.loadSync(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getProviderIds()).toContain("test-video");
		const provider = config.getProvider("test-video");
		expect(provider).toBeDefined();
		expect(provider?.modelOverrides?.["video-model"]?.input).toEqual(["text", "image", "video"]);
	});

	it("rejects audio as an input modality", () => {
		const path = writeModelsJson(tempDir(), {
			providers: {
				"test-video": {
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					models: [{ id: "audio-model", input: ["text", "audio"] }],
				},
			},
		});

		const config = ModelConfig.loadSync(path);
		expect(config.getError()).toContain("Invalid models.json schema");
	});
});
