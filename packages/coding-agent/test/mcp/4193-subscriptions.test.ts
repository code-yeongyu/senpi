import { expect, it } from "vitest";
import { openFixture } from "./fixtures/subscriptions-http.ts";
import { ensureMcpResourceSubscriptions } from "../../src/core/extensions/builtin/mcp/resources.ts";
import { collectServerCatalogForCache } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";

it("4193 a connected modern catalog opens subscriptions/listen with list-change opt-ins", async () => {
	const fixture = await openFixture();
	try {
		await fixture.client.listTools();
		await fixture.client.listPrompts();
		await fixture.client.listResources();
		const methods = fixture.requests.map(({ message }) => message.method);
		expect(methods).toContain("server/discover");
		expect(methods).toContain("tools/list");
		// Connect and all initial lists are complete: no timer or network polling guesses.
		expect(methods).toContain("subscriptions/listen");
		const listen = fixture.requests.find(({ message }) => message.method === "subscriptions/listen");
		expect(listen?.message.params?.notifications).toMatchObject({
			toolsListChanged: true,
			promptsListChanged: true,
			resourcesListChanged: true,
		});
	} finally {
		await fixture.close();
	}
});

it("4193 omits undeclared filters and keeps calls independent of the listen lifetime", async () => {
	const fixture = await openFixture({ capabilities: { tools: {}, resources: {}, prompts: {} } });
	try {
		await fixture.client.listTools();
		await fixture.client.listResources();
		await ensureMcpResourceSubscriptions(fixture.client, [{ uri: "test://data" }]);
		await fixture.client.callTool({ name: "echo" });
		expect(fixture.requests.map(({ message }) => message.method)).not.toContain("subscriptions/listen");
		expect(fixture.requests.map(({ message }) => message.method)).not.toContain("resources/subscribe");
	} finally {
		await fixture.close();
	}
});

it.each([
	"notifications/tools/list_changed",
	"notifications/prompts/list_changed",
	"notifications/resources/list_changed",
	"notifications/resources/updated",
])("4193 %s invalidates and refetches the existing catalog", async (method) => {
	const tools = [{ name: "before", inputSchema: { type: "object" } }];
	const fixture = await openFixture({ tools });
	try {
		const subscribed = fixture.next("subscriptions/listen");
		await collectServerCatalogForCache(fixture.connection, { requestTimeoutMs: 10000 }, "synthetic");
		await subscribed;
		await ensureMcpResourceSubscriptions(fixture.client, [{ uri: "test://data" }]);
		// Observe the final resource-filter stream on the server, not a timed polling guess.
		const resourceStream = fixture.streams.findLast(
			({ message }) =>
				(message.params?.notifications as { resourceSubscriptions?: string[] })?.resourceSubscriptions?.length,
		);
		if (!resourceStream) {
			await fixture.next("subscriptions/listen");
		}
		const stream = fixture.streams.at(-1);
		if (!stream) throw new Error("Missing subscription stream");
		const refreshed = Promise.withResolvers<Awaited<ReturnType<typeof collectServerCatalogForCache>>>();
		const off = fixture.connection.onToolsChanged(() => {
			void collectServerCatalogForCache(fixture.connection, { requestTimeoutMs: 10000 }, "synthetic").then(
				refreshed.resolve,
				refreshed.reject,
			);
		});
		tools[0] = { name: "after", inputSchema: { type: "object" } };
		stream.response.write(
			`data: ${JSON.stringify({
				jsonrpc: "2.0",
				method,
				params: {
					_meta: { "io.modelcontextprotocol/subscriptionId": stream.message.id },
					...(method === "notifications/resources/updated" ? { uri: "test://data" } : {}),
				},
			})}\n\n`,
		);
		const catalog = await refreshed.promise;
		off();
		expect(catalog.tools.map(({ name }) => name)).toEqual(["after"]);
		expect(fixture.requests.map(({ message }) => message.method)).not.toContain("resources/subscribe");
		// The open stream must not occupy the application request path.
		expect((await fixture.client.callTool({ name: "after" })).content).toEqual([]);
	} finally {
		await fixture.close();
	}
});

it("4193 disposal aborts the outstanding HTTP listen stream", async () => {
	const fixture = await openFixture();
	try {
		const listening = fixture.next("subscriptions/listen");
		await fixture.client.listTools();
		await listening;
		const response = fixture.streams[0]?.response;
		if (!response) throw new Error("Missing HTTP listen stream");
		const closed = new Promise<void>((resolve) => response.once("close", resolve));
		await fixture.connection.dispose();
		await closed;
	} finally {
		await fixture.close();
	}
});

it("4193 connection renewal closes its old stream and reestablishes subscriptions", async () => {
	const fixture = await openFixture();
	try {
		const first = fixture.next("subscriptions/listen");
		await fixture.client.listTools();
		const original = await first;
		const oldStream = fixture.streams[0]?.response;
		if (!oldStream) throw new Error("Missing old subscription stream");
		const closed = new Promise<void>((resolve) => oldStream.once("close", resolve));
		await fixture.connection.renew();
		await closed;
		const renewed = fixture.next("subscriptions/listen");
		await fixture.connection.client.listTools();
		expect((await renewed).id).not.toBe(original.id);
	} finally {
		await fixture.close();
	}
});
