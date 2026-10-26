import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { openHeaderFixture } from "./fixtures/header-http-server.ts";

// #4192: ported RED assertions exercise ServerConnection and the real HTTP/SDK path.
it("mirrors annotated arguments at their exact nested paths", async () => {
	const fixture = await openHeaderFixture([
		{
			name: "echo",
			inputSchema: {
				type: "object",
				properties: {
					region: { type: "string", "x-mcp-header": "Region" },
					nested: { type: "object", properties: { flag: { type: "boolean", "x-mcp-header": "Flag" } } },
				},
			},
		},
	]);
	try {
		await fixture.client.listTools();
		await fixture.client.callTool({ name: "echo", arguments: { region: "us-west1", nested: { flag: false } } });
		const wire = fixture.requests.find(({ message }) => message.method === "tools/call");
		expect(wire?.headers["mcp-name"]).toBe("echo");
		expect.soft(wire?.headers["mcp-param-region"]).toBe("us-west1");
		expect.soft(wire?.headers["mcp-param-flag"]).toBe("false");
	} finally {
		await fixture.close();
	}
});

it.each(["snowman-\u2603", " padded ", "=?base64?literal?="])(
	"encodes Mcp-Name with standard Base64 and the spec sentinel for %j",
	async (name) => {
		const fixture = await openHeaderFixture([{ name, inputSchema: { type: "object" } }]);
		try {
			await fixture.client.listTools();
			await fixture.client.callTool({ name });
			const wire = fixture.requests.find(({ message }) => message.method === "tools/call");
			expect(wire?.headers["mcp-name"]).toBe(`=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`);
		} finally {
			await fixture.close();
		}
	},
);

it("excludes an invalid number annotation without losing valid tools", async () => {
	const fixture = await openHeaderFixture([
		{ name: "good", inputSchema: { type: "object" } },
		{
			name: "bad",
			inputSchema: { type: "object", properties: { value: { type: "number", "x-mcp-header": "Value" } } },
		},
	]);
	try {
		const result = await fixture.client.listTools();
		expect(result.tools.map(({ name }) => name)).toEqual(["good"]);
	} finally {
		await fixture.close();
	}
});

it.each([
	{ properties: { value: { type: "string", "x-mcp-header": "" } } },
	{ properties: { value: { type: "string", "x-mcp-header": "bad name" } } },
	{ properties: { value: { type: "string", "x-mcp-header": "bad\r\nname" } } },
	{ properties: { value: { type: "string", "x-mcp-header": 1 } } },
	{ properties: { value: { type: ["string", "null"], "x-mcp-header": "Value" } } },
	{ properties: { first: { type: "string", "x-mcp-header": "A" }, second: { type: "boolean", "x-mcp-header": "a" } } },
	{ type: "string", "x-mcp-header": "Root" },
	{ properties: { values: { type: "array", items: { type: "string", "x-mcp-header": "Value" } } } },
	{ allOf: [{ properties: { value: { type: "string", "x-mcp-header": "Value" } } }] },
	{ if: { properties: { value: { type: "string", "x-mcp-header": "Value" } } } },
	{ $defs: { value: { type: "string", "x-mcp-header": "Value" } }, properties: { value: { $ref: "#/$defs/value" } } },
	{ additionalProperties: { type: "string", "x-mcp-header": "Value" } },
])("rejects invalid header definitions in schema %j", async (inputSchema) => {
	const fixture = await openHeaderFixture([
		{ name: "bad", inputSchema: { type: "object", ...inputSchema } },
		{ name: "good", inputSchema: { type: "object" } },
	]);
	try {
		expect((await fixture.client.listTools()).tools.map(({ name }) => name)).toEqual(["good"]);
	} finally {
		await fixture.close();
	}
});

it.each([false, true])(
	"encodes primitive values and omits undeclared, absent, and invalid values (SSE %j)",
	async (sse) => {
		const fixture = await openHeaderFixture(
			[
				{
					name: "echo",
					inputSchema: {
						type: "object",
						properties: {
							text: { type: "string", "x-mcp-header": "Text" },
							count: { type: "integer", "x-mcp-header": "Count" },
							flag: { type: "boolean", "x-mcp-header": "Flag" },
							missing: { type: "string", "x-mcp-header": "Missing" },
							nested: { type: "object", properties: { private: { type: "string" } } },
						},
						examples: [{ "x-mcp-header": "this is instance data" }],
					},
				},
			],
			{ sse, headers: { "Mcp-Param-Missing": "must-not-project", "Mcp-Param-Extra": "must-not-project" } },
		);
		try {
			await fixture.client.listTools();
			for (const text of ["Hello, \u4e16\u754c", " padded ", "line\nbreak", "=?base64?literal?=", "a\tb", ""]) {
				await fixture.client.callTool({
					name: "echo",
					arguments: {
						text,
						count: -42,
						flag: true,
						private: "not-declared",
						nested: { private: "not-declared" },
					},
				});
				const wire = fixture.requests.at(-1);
				const expected = ["a\tb", ""].includes(text) ? text : `=?base64?${Buffer.from(text).toString("base64")}?=`;
				expect(wire?.headers["mcp-param-text"]).toBe(expected);
				expect(wire?.headers["mcp-param-count"]).toBe("-42");
				expect(wire?.headers["mcp-param-flag"]).toBe("true");
				expect(
					Object.keys(wire?.headers ?? {})
						.filter((key) => key.startsWith("mcp-param-"))
						.sort(),
				).toEqual(["mcp-param-count", "mcp-param-flag", "mcp-param-text"]);
			}
			await fixture.client.callTool({ name: "echo", arguments: { text: null, count: 2 ** 53, flag: "false" } });
			expect(
				Object.keys(fixture.requests.at(-1)?.headers ?? {}).filter((key) => key.startsWith("mcp-param-")),
			).toEqual([]);
		} finally {
			await fixture.close();
		}
	},
);

it("forgets old annotations after a catalog refresh", async () => {
	const fixture = await openHeaderFixture([
		{
			name: "echo",
			inputSchema: { type: "object", properties: { text: { type: "string", "x-mcp-header": "Text" } } },
		},
	]);
	try {
		await fixture.client.listTools();
		fixture.tools.splice(0);
		await fixture.client.listTools();
		await fixture.client.callTool({ name: "echo", arguments: { text: "not-current" } });
		expect(fixture.requests.at(-1)?.headers["mcp-param-text"]).toBeUndefined();
	} finally {
		await fixture.close();
	}
});

it("leaves legacy HTTP catalogs and parameter-header behavior unchanged", async () => {
	const tools = [
		{
			name: "echo",
			inputSchema: { type: "object", properties: { text: { type: "string", "x-mcp-header": "Text" } } },
		},
		{
			name: "bad",
			inputSchema: { type: "object", properties: { text: { type: "number", "x-mcp-header": "Text" } } },
		},
	];
	const fixture = await openHeaderFixture(tools, { legacy: true });
	try {
		expect((await fixture.client.listTools()).tools.map(({ name }) => name)).toEqual(["echo", "bad"]);
		await fixture.client.callTool({ name: "echo", arguments: { text: "not-projected" } });
		expect(fixture.requests.at(-1)?.headers["mcp-param-text"]).toBeUndefined();
	} finally {
		await fixture.close();
	}
});
