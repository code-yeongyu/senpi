/**
 * Reads the models.json provider `models discover` fills (senpi#2196). A missing or empty file
 * declares no providers, so either one ends in the same "declare it first" guidance
 * (oh-my-openagent#14414); malformed JSON stays an error that names the file and position.
 */

import { readFileSync } from "node:fs";
import { normalizeProviderId } from "@earendil-works/pi-ai";
import { jsonSyntaxErrorPosition, stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

export class ModelsDiscoveryError extends Error {}

export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export interface ConfiguredProvider {
	content: string;
	document: JsonRecord;
	key: string;
	providers: JsonRecord;
	provider: JsonRecord;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function notDeclared(providerId: string, modelsPath: string, fileMissing: boolean): ModelsDiscoveryError {
	const example = {
		providers: {
			[providerId]: {
				baseUrl: "https://your-endpoint.example/v1",
				api: "openai-completions",
				apiKey: "$MY_API_KEY",
			},
		},
	};
	return new ModelsDiscoveryError(
		[
			`Provider "${providerId}" is not declared in ${modelsPath}${fileMissing ? " (the file does not exist yet)" : ""}.`,
			'models discover fills the "models" list of an OpenAI-compatible provider declared there, for example:',
			JSON.stringify(example, null, 2),
			"Built-in providers need no discovery: their catalogs refresh automatically.",
		].join("\n"),
	);
}

function parseDocument(json: string, modelsPath: string): JsonRecord {
	if (json.trim() === "") return {};
	let document: unknown;
	try {
		document = JSON.parse(json);
	} catch (error) {
		throw new ModelsDiscoveryError(
			`Cannot parse ${modelsPath} at ${jsonSyntaxErrorPosition(json)}: ${errorMessage(error)}`,
		);
	}
	if (!isRecord(document)) throw new ModelsDiscoveryError(`${modelsPath} is not a JSON object`);
	return document;
}

export function readConfiguredProvider(modelsPath: string, providerId: string): ConfiguredProvider {
	let content: string;
	try {
		content = readFileSync(modelsPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notDeclared(providerId, modelsPath, true);
		throw new ModelsDiscoveryError(`Cannot read ${modelsPath}: ${errorMessage(error)}`);
	}
	const document = parseDocument(stripJsonComments(stripBom(content)), modelsPath);
	const wanted = normalizeProviderId(providerId);
	const providers = isRecord(document.providers) ? document.providers : {};
	const key = Object.keys(providers).find((candidate) => normalizeProviderId(candidate) === wanted);
	const provider = key === undefined ? undefined : providers[key];
	if (key === undefined || !isRecord(provider)) throw notDeclared(providerId, modelsPath, false);
	return { content, document, key, providers, provider };
}
