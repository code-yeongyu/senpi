import { describe, expect, it } from "vitest";
import { type DeviceCustodyReason, deviceCustodyReasons } from "../../src/core/egress/device-custody.ts";
import type { ModelsJsonProvider } from "../../src/core/model-config-schema.ts";

function provider(json: string): ModelsJsonProvider {
	return JSON.parse(json);
}

describe("deviceCustodyReasons", () => {
	it("lets a plain provider be sealed", () => {
		const plain = provider(`{
			"baseUrl": "https://api.example.test/v1",
			"apiKey": { "$env": "EXAMPLE_KEY" },
			"headers": { "x-team": "t1" },
			"extraBody": {},
			"compat": { "chatTemplateKwargs": { "think": { "$var": "thinking.enabled" } }, "openRouterRouting": { "sort": { "by": "price" } } },
			"credentials": { "slots": { "a": { "env": "KEY_A" } } },
			"models": [{ "id": "m", "baseUrl": "https://other.example.test/v1", "headers": { "x-m": "1" }, "samplingParams": { "temperature": 0.2, "top_k": null } }],
			"modelOverrides": { "m": { "headers": { "x-o": "2" }, "samplingParams": { "seed": 7 } } }
		}`);
		expect(deviceCustodyReasons(plain)).toEqual([]);
	});

	const cases: readonly (readonly [string, string, DeviceCustodyReason])[] = [
		["an undeclared provider key", `{ "secretToken": "sk-123" }`, "undeclared-field"],
		["a misspelled secret field", `{ "api_key": "sk-123" }`, "undeclared-field"],
		["an undeclared model key", `{ "models": [{ "id": "m", "internalNote": "hunter2" }] }`, "undeclared-field"],
		[
			"an undeclared override key with an empty value",
			`{ "modelOverrides": { "m": { "foo": {} } } }`,
			"undeclared-field",
		],
		["an undeclared compat key", `{ "compat": { "token": "x" } }`, "undeclared-field"],
		["an object where a leaf belongs", `{ "name": { "nested": "x" } }`, "undeclared-field"],
		["provider extraBody", `{ "extraBody": { "route": "x" } }`, "extra-body"],
		["a null extraBody value", `{ "extraBody": { "route": null } }`, "extra-body"],
		["model extraBody", `{ "models": [{ "id": "m", "extraBody": { "route": "x" } }] }`, "extra-body"],
		["override extraBody", `{ "modelOverrides": { "m": { "extraBody": { "route": "x" } } } }`, "extra-body"],
		[
			"a string samplingParams value",
			`{ "models": [{ "id": "m", "samplingParams": { "stop": "END" } }] }`,
			"sampling-params",
		],
		[
			"an object samplingParams value",
			`{ "modelOverrides": { "m": { "samplingParams": { "x": { "y": 1 } } } } }`,
			"sampling-params",
		],
		[
			"model URL with a key-ish query",
			`{ "models": [{ "id": "m", "baseUrl": "https://h.test/v1?key=k" }] }`,
			"model-base-url-secret",
		],
		[
			"model URL with a template",
			`{ "models": [{ "id": "m", "baseUrl": "https://h.test/$TENANT/v1" }] }`,
			"model-base-url-secret",
		],
		["unsplittable provider URL", `{ "baseUrl": "https://h.test/v1#x" }`, "unsplittable-base-url"],
		["unsplittable model URL", `{ "models": [{ "id": "m", "baseUrl": "ftp://h.test" }] }`, "unsplittable-base-url"],
		[
			"one header name at both model levels",
			`{ "models": [{ "id": "m", "headers": { "x-k": "1" } }], "modelOverrides": { "m": { "headers": { "x-k": "2" } } } }`,
			"model-header-collision",
		],
	];
	it.each(cases)("keeps a provider with %s on the device", (_name, json, reason) => {
		expect(deviceCustodyReasons(provider(json))).toEqual([reason]);
	});
});
