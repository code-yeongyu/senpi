import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it } from "vitest";
import type { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import {
	beginLegacyMcpOperation,
	createMcpRequestOrigin,
	legacyMcpOperation,
} from "../../src/core/extensions/builtin/mcp/request-origin.ts";

// senpi#4245: a finished operation still awaiting removal is not a second origin for a legacy form.
it("resolves a legacy form to the one live operation next to finished ones", () => {
	const client = {} as Client;
	const origin = createMcpRequestOrigin({
		binding: {},
		connection: {} as ServerConnection,
		signal: new AbortController().signal,
		serverLabel: "fixture",
		isCurrent: () => true,
		resolveAuthority: async () => null,
	});
	const finished = new AbortController();
	const ends = [beginLegacyMcpOperation(client, origin, finished.signal), beginLegacyMcpOperation(client, origin)];
	finished.abort();
	try {
		expect(legacyMcpOperation(client)).toMatchObject({ origin });
		ends.push(beginLegacyMcpOperation(client, origin));
		expect(legacyMcpOperation(client)).toBe("ambiguous");
	} finally {
		for (const end of ends) end();
	}
	expect(legacyMcpOperation(client)).toBeUndefined();
});
