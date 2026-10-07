import type { JsonObject, JsonValue } from "../types.ts";
import { getArray, getObject, getString, isJsonObject } from "./shared.ts";

function parseJson(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function streamErrorMessage(event: JsonObject): string {
	const response = getObject(event.response);
	const sources = [event, getObject(event.error), getObject(response?.error)];
	const code = sources.map((source) => getString(source?.code)).find((value) => value);
	const message = sources.map((source) => getString(source?.message)).find((value) => value);
	if (code && message) return `${code}: ${message}`;
	return message ?? code ?? "The search stream failed.";
}

function eventData(block: string): string {
	return block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
}

/** Folds a streamed Responses reply into `{ output }`; a stream failure becomes `error.message`, a JSON body passes through. */
export function collectResponseStream(bodyText: string): JsonObject {
	if (bodyText.trimStart().startsWith("{")) {
		const parsed = parseJson(bodyText);
		return isJsonObject(parsed) ? parsed : {};
	}

	const doneItems: JsonValue[] = [];
	let completedOutput: JsonValue[] = [];
	let error: string | undefined;
	for (const block of bodyText.split(/\r?\n\r?\n/)) {
		const data = eventData(block);
		if (!data || data === "[DONE]") continue;
		const event = parseJson(data);
		if (!isJsonObject(event)) continue;
		switch (event.type) {
			case "response.output_item.done": {
				const item = getObject(event.item);
				if (item) doneItems.push(item);
				break;
			}
			case "response.completed":
			case "response.done":
				completedOutput = getArray(getObject(event.response)?.output);
				break;
			case "error":
			case "response.failed":
				error = streamErrorMessage(event);
				break;
		}
	}

	const payload: JsonObject = { output: doneItems.length > 0 ? doneItems : completedOutput };
	if (error) payload.error = { message: error };
	return payload;
}
