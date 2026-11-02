/**
 * Searchable Tools Example
 * Demonstrates declarative search exposure for large tool catalogs.
 */

import { defineTool, type ExtensionAPI } from "@code-yeongyu/senpi";
import { Type } from "typebox";

const dictionaryLookup = defineTool({
	name: "lookup_dictionary",
	label: "Dictionary Lookup",
	description: "Look up definitions of words",
	exposure: "search",
	searchText: "Find meanings and definitions of English words",
	searchKeywords: ["dictionary", "meaning", "definition"],
	allowLazyActivation: true,
	parameters: Type.Object({
		word: Type.String(),
	}),
	async execute(_id, params) {
		return {
			content: [{ type: "text", text: `Definition for ${params.word}: [example definition]` }],
			details: {},
		};
	},
});

const privateDatabaseQuery = defineTool({
	name: "query_private_db",
	label: "Query Private DB",
	description: "Query the sensitive private database",
	exposure: "search",
	searchText: "Access protected company records",
	allowLazyActivation: false, // Cannot be lazily activated; must be explicitly enabled
	parameters: Type.Object({
		query: Type.String(),
	}),
	async execute(_id, params) {
		return {
			content: [{ type: "text", text: `Results for ${params.query}: [secret data]` }],
			details: {},
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(dictionaryLookup);
	pi.registerTool(privateDatabaseQuery);
}
