#!/usr/bin/env node

import { writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { ImagesApi, ImagesModel } from "../src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function readStrictOption(args: string[]): boolean {
	for (const arg of args) {
		if (arg !== "--strict") throw new Error(`Unknown argument: ${arg}`);
	}
	return args.includes("--strict");
}

interface OpenRouterModelRecord {
	id: string;
	name: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
}

export function parseOpenRouterImageModels(
	payload: unknown,
	strict: boolean,
): ImagesModel<"openrouter-images">[] {
	const data =
		typeof payload === "object" && payload !== null
			? (payload as { data?: OpenRouterModelRecord[] }).data
			: undefined;
	if (!Array.isArray(data) || data.length === 0) {
		if (strict) throw new Error("OpenRouter API returned a missing or empty image model list");
		return [];
	}

	const models: ImagesModel<"openrouter-images">[] = [];
	for (const model of data) {
		const input = Array.from(
			new Set(
				(model.architecture?.input_modalities ?? []).filter(
					(modality): modality is "text" | "image" => modality === "text" || modality === "image",
				),
			),
		);
		const output = Array.from(
			new Set(
				(model.architecture?.output_modalities ?? []).filter(
					(modality): modality is "text" | "image" => modality === "text" || modality === "image",
				),
			),
		);

		if (!output.includes("image")) continue;
		if (input.length === 0) input.push("text");

		models.push({
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: OPENROUTER_BASE_URL,
			input,
			output,
			cost: {
				input: parseFloat(model.pricing?.prompt || "0") * 1_000_000,
				output: parseFloat(model.pricing?.completion || "0") * 1_000_000,
				cacheRead: parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000,
				cacheWrite: parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000,
			},
		});
	}

	if (strict && models.length === 0) {
		throw new Error("OpenRouter API returned no usable image models");
	}
	return models;
}

// Static OpenAI image models. The OpenRouter fetch below stays the only live
// source; these entries are hand-authored because OpenAI's own API exposes no
// public image-model catalog to fetch from.
// Costs quoted from models.dev (https://models.dev/api.json, openai provider)
// as of 2026-08-11: gpt-image-2 $5 input / $30 output / $1.25 cache-read per
// 1M tokens; gpt-image-1.5 has no models.dev cost entry as of that date, so
// its cost is zero-filled until pricing is published.
// Input is ["text"] only: the v1 generations endpoint is text-only.
const OPENAI_IMAGE_MODELS: ImagesModel<"openai-images">[] = [
	{
		id: "gpt-image-2",
		name: "GPT Image 2",
		api: "openai-images",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0 },
	},
	{
		id: "gpt-image-1.5",
		name: "GPT Image 1.5",
		api: "openai-images",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

async function fetchOpenRouterImageModels(strict: boolean): Promise<ImagesModel<"openrouter-images">[]> {
	try {
		console.log("Fetching image models from OpenRouter API...");
		const response = await fetch(`${OPENROUTER_BASE_URL}/models?output_modalities=image`);
		if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
		const models = parseOpenRouterImageModels(await response.json(), strict);
		console.log(`Fetched ${models.length} image models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter image models:", error);
		if (strict) throw error;
		return [];
	}
}

function serializeImageModel(model: ImagesModel<ImagesApi>): string {
	return `{
			id: ${JSON.stringify(model.id)},
			name: ${JSON.stringify(model.name)},
			api: ${JSON.stringify(model.api)},
			provider: ${JSON.stringify(model.provider)},
			baseUrl: ${JSON.stringify(model.baseUrl)},
			input: ${JSON.stringify(model.input)},
			output: ${JSON.stringify(model.output)},
			cost: ${JSON.stringify(model.cost, null, 2).replace(/^/gm, "\t")}
		} satisfies ImagesModel<${JSON.stringify(model.api)}>`;
}

function generateImageModelsFile(openrouterModels: ImagesModel<"openrouter-images">[]): string {
	const imageModelsByProvider: Record<string, ImagesModel<ImagesApi>[]> = {
		openai: [...OPENAI_IMAGE_MODELS],
		openrouter: [...openrouterModels].sort((a, b) => a.id.localeCompare(b.id)),
	};

	const providerEntries = Object.entries(imageModelsByProvider)
		.map(([provider, providerModels]) => {
			const modelEntries = providerModels
				.map((model) => `\t\t${JSON.stringify(model.id)}: ${serializeImageModel(model)},`)
				.join("\n");
			return `\t${JSON.stringify(provider)}: {\n${modelEntries}\n\t},`;
		})
		.join("\n");

	return `// This file is auto-generated by scripts/generate-image-models.ts
// Do not edit manually - run 'npm run generate-image-models' to update

import type { ImagesApi, ImagesModel } from "./types.ts";

export const IMAGE_MODELS = {
${providerEntries}
} as const satisfies Record<string, Record<string, ImagesModel<ImagesApi>>>;
`;
}

async function main(): Promise<void> {
	const strict = readStrictOption(process.argv.slice(2));
	const models = await fetchOpenRouterImageModels(strict);
	const output = generateImageModelsFile(models);
	const outputPath = join(packageRoot, "src", "image-models.generated.ts");
	writeFileSync(outputPath, output, "utf-8");
	console.log(`Generated ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
