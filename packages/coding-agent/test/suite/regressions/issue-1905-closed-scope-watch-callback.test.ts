import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { describe, expect, it } from "vitest";
import { bindSessionScopedCallback } from "../../../src/core/extensions/builtin/config-reload/session-scoped-callback.ts";

// senpi#1905: the config-reload watcher bound its callbacks to the session's provider
// scope and let them throw "Provider scope is closed" from a debounce timer once the
// session was gone - an unhandled rejection per filesystem event, forever.

describe("issue 1905: watcher callbacks of a closed session scope", () => {
	it("drops a callback fired after its scope closed instead of throwing", () => {
		// Given: a callback bound while its session scope is active
		const scope = new ProviderScope();
		const calls: string[] = [];
		const bound = runWithProviderScope(scope, () => bindSessionScopedCallback((path: string) => calls.push(path)));
		bound("settings.json");
		expect(calls).toEqual(["settings.json"]);

		// When: the session is torn down and a late watcher event still fires
		scope.close();

		// Then: the event is dropped without throwing
		expect(() => bound("settings.json")).not.toThrow();
		expect(calls).toEqual(["settings.json"]);
	});

	it("refuses to bind a callback inside a session scope it cannot read (omo#12965)", () => {
		// Given: a scope entered by a pi-ai copy that shapes scopes differently
		const registry = Reflect.get(globalThis, Symbol.for("@code-yeongyu/senpi/provider-scope/v1")) as {
			run: (scope: unknown, fn: () => unknown) => unknown;
		};

		// When / Then: the bind refuses, so the callback is never handed back unbound inside a session
		expect(() => registry.run({ state: "active" }, () => bindSessionScopedCallback(() => {}))).toThrow(
			expect.objectContaining({ code: "PI_PROVIDER_SCOPE_UNREADABLE" }),
		);
	});

	it("returns the callback unbound when no session scope is active", () => {
		// Given: classic single-session mode, no provider scope
		const calls: number[] = [];
		const bound = bindSessionScopedCallback((value: number) => calls.push(value));

		// When: it fires
		bound(1);

		// Then: it runs as a plain callback
		expect(calls).toEqual([1]);
	});
});
