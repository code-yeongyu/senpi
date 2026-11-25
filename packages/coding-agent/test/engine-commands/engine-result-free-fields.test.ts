import { describe, expect, expectTypeOf, it } from "vitest";
import type { LaunchPrintEvent } from "../../src/engine/launch-print-stream.ts";
import { type engine, type FieldPaths, type FreeFieldPaths, RESULT_FREE_FIELDS } from "../../src/engine/index.ts";

type Engine = typeof engine;
type Answer<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

/** Each exported function's answer, by the call name the table uses, plus the print stream's events. */
type Answers = {
	"packages.install": Answer<Engine["packages"]["install"]>;
	"packages.remove": Answer<Engine["packages"]["remove"]>;
	"packages.list": Answer<Engine["packages"]["list"]>;
	"packages.update": Answer<Engine["packages"]["update"]>;
	"models.update": Answer<Engine["models"]["update"]>;
	"models.discover": Answer<Engine["models"]["discover"]>;
	"models.list": Answer<Engine["models"]["list"]>;
	"config.agentDir": Answer<Engine["config"]["agentDir"]>;
	"config.resources": Answer<Engine["config"]["resources"]>;
	"config.setResource": Answer<Engine["config"]["setResource"]>;
	"schedule.list": Answer<Engine["schedule"]["list"]>;
	"schedule.cancel": Answer<Engine["schedule"]["cancel"]>;
	"schedule.run": Answer<Engine["schedule"]["run"]>;
	sessionOfPid: Answer<Engine["sessionOfPid"]>;
	"sessions.exportHtml": Answer<Engine["sessions"]["exportHtml"]>;
	promptSizes: Answer<Engine["promptSizes"]>;
	tips: Answer<Engine["tips"]>;
	"host.ensure": Answer<Engine["host"]["ensure"]>;
	"host.status": Answer<Engine["host"]["status"]>;
	"host.stop": Answer<Engine["host"]["stop"]>;
	"host.handoff": Answer<Engine["host"]["handoff"]>;
	"host.gc": Answer<Engine["host"]["gc"]>;
	"host.shardPath": Answer<Engine["host"]["shardPath"]>;
	"auth.check": Answer<Engine["auth"]["check"]>;
	"auth.credentials": Answer<Engine["auth"]["credentials"]>;
	"auth.apiKey": Answer<Engine["auth"]["apiKey"]>;
	"auth.bearerToken": Answer<Engine["auth"]["bearerToken"]>;
	"launch.interactive": Answer<Engine["launch"]["interactive"]>;
	"launch.print": Answer<Engine["launch"]["print"]>;
	"launch.rpc": Answer<Engine["launch"]["rpc"]>;
	"launch.hand": Answer<Engine["launch"]["hand"]>;
	"launch.headless": Answer<Engine["launch"]["headless"]>;
	"launch.print#events": LaunchPrintEvent;
};

type Entry = (typeof RESULT_FREE_FIELDS)[number];
type Pattern<F extends string> = F extends `${infer Root}.*` ? `${Root}.${string}` : F;
type Covered<C extends string> =
	Extract<Entry, { readonly call: C | "*" }> extends infer E
		? E extends { readonly field: infer F extends string }
			? Pattern<F>
			: never
		: never;
type Uncovered = { [C in keyof Answers & string]: Exclude<FreeFieldPaths<Answers[C]>, Covered<C>> };
type Stale = Entry extends infer E
	? E extends { readonly call: infer C extends string; readonly field: infer F extends string }
		? [Extract<FreeFieldPaths<C extends keyof Answers ? Answers[C] : Answers[keyof Answers]>, Pattern<F>>] extends [
				never,
			]
			? E
			: never
		: never
	: never;

/** A key whose purpose is to hold a credential or a transport setting: no answer may carry one. */
type Forbidden =
	| "headers"
	| "baseUrl"
	| "apiKey"
	| "api_key"
	| "token"
	| "accessToken"
	| "refreshToken"
	| "access"
	| "refresh"
	| "secret"
	| "password"
	| "authorization"
	| "env"
	| "environment"
	| "credential"
	| "credentials";
type ForbiddenPaths = Extract<FieldPaths<Answers[keyof Answers]>, Forbidden | `${string}.${Forbidden}`>;

describe("every free field of every answer is classified (security owner ruling, senpi#7451)", () => {
	it("leaves no free field of any answer outside the table, and no table entry that names nothing", () => {
		expectTypeOf<Uncovered[keyof Uncovered]>().toEqualTypeOf<never>();
		expectTypeOf<Stale>().toEqualTypeOf<never>();
	});

	it("lets no answer carry a field whose purpose is a credential or a transport setting", () => {
		expectTypeOf<ForbiddenPaths>().toEqualTypeOf<never>();
	});

	it("fires on a synthetic answer that has a transport field and an unclassified string (negative controls)", () => {
		type Leaky = { readonly value: { readonly baseUrl: string; readonly headers: Readonly<Record<string, string>> } };
		expectTypeOf<Extract<FieldPaths<Leaky>, Forbidden | `${string}.${Forbidden}`>>().toEqualTypeOf<
			"value.baseUrl" | "value.headers"
		>();
		expectTypeOf<Exclude<FreeFieldPaths<Leaky>, Covered<"tips">>>().toEqualTypeOf<
			"value.baseUrl" | "value.headers" | "value.headers.{}"
		>();
	});

	it("marks only the engine's own text as unable to embed a credential, each field once", () => {
		for (const entry of RESULT_FREE_FIELDS) expect(entry.may_embed, entry.field).toBe(entry.origin !== "engine");
		const keys = RESULT_FREE_FIELDS.map((entry) => `${entry.call} ${entry.field}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
