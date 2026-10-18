#!/usr/bin/env node

import assert from "node:assert/strict";
import { READ_FOLDER_SELECTION, selectedReadFolder } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

// Provider events only. The session's registered read tool is never replaced or wrapped.
export default function readSummaryProvider(pi) {
	const faux = fauxProvider({
		api: "read-summary-fixture",
		tokenSize: { min: 16000, max: 16000 },
		provider: "read-summary-fixture",
		models: [{ id: "read-summary", contextWindow: 2000000, maxTokens: 4096 }],
	});
	pi.registerProvider(faux.provider);
	pi.on("input", (event) => {
		const calls = JSON.parse(event.text);
		assert(Array.isArray(calls) && calls.length > 0);
		for (const call of calls) {
			assert.equal(typeof call.id, "string");
			assert.equal(typeof call.args.path, "string");
			assert(Object.keys(call.args).every((key) => ["path", "offset", "limit"].includes(key)));
		}
		faux.setResponses([
			fauxAssistantMessage(
				calls.map((call) => fauxToolCall("read", call.args, { id: call.id })),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				JSON.stringify({
					folder: { id: selectedReadFolder.id, version: selectedReadFolder.version },
					selection: READ_FOLDER_SELECTION,
					// What this build may load, stated from the frozen selection itself (#1685).
					parserInitCounters: {
						wasm: Object.values(READ_FOLDER_SELECTION.languages).filter((engine) => engine === "wasm").length,
						selectedParserRuntimes: READ_FOLDER_SELECTION.wasm ? 1 : 0,
					},
				}),
			),
		]);
		return { action: "continue" };
	});
}
