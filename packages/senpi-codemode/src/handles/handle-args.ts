import type { HandleRef, OutputRequest } from "@code-yeongyu/senpi";
import { type Static, type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";

/** Wire shapes of the five reserved handle tools; every ref carries kind, id and run epoch so the host can fence it. */
const handleRefSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("agent"), Type.Literal("completion"), Type.Literal("workpool")]),
		id: Type.String({ minLength: 1 }),
		run_epoch: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: true },
);

export const WAIT_MODES = ["all", "any", "settled"] as const;
export type WaitMode = (typeof WAIT_MODES)[number];

const waitArgsSchema = Type.Object(
	{
		refs: Type.Array(handleRefSchema),
		timeout: Type.Optional(Type.Number({ minimum: 0 })),
		mode: Type.Optional(Type.Union(WAIT_MODES.map((mode) => Type.Literal(mode)))),
	},
	{ additionalProperties: false },
);
const refArgsSchema = Type.Object({ ref: handleRefSchema }, { additionalProperties: false });
const outputArgsSchema = Type.Object(
	{
		ref: handleRefSchema,
		format: Type.Optional(Type.Union([Type.Literal("raw"), Type.Literal("tail")])),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
const sendArgsSchema = Type.Object(
	{ ref: handleRefSchema, message: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

export interface WaitRequest {
	readonly refs: readonly HandleRef[];
	readonly mode: WaitMode;
	readonly timeoutSeconds?: number;
}

export class HandleArgumentsError extends Error {
	readonly name = "HandleArgumentsError";
	readonly code = "eval_handle_invalid_arguments";

	constructor(helper: string, summary: string) {
		super(`eval_handle_invalid_arguments: ${helper} received invalid arguments: ${summary}`);
	}
}

export function parseWaitArgs(value: unknown): WaitRequest {
	const parsed = parseWith(waitArgsSchema, value, "wait()");
	if (parsed.timeout !== undefined && !Number.isFinite(parsed.timeout)) {
		throw new HandleArgumentsError("wait()", "timeout must be a finite number of seconds >= 0");
	}
	return {
		refs: parsed.refs.map(toRef),
		mode: parsed.mode ?? "all",
		...(parsed.timeout === undefined ? {} : { timeoutSeconds: parsed.timeout }),
	};
}

export function parseRefArgs(value: unknown, helper: string): HandleRef {
	return toRef(parseWith(refArgsSchema, value, helper).ref);
}

export function parseOutputArgs(value: unknown): { readonly ref: HandleRef; readonly request: OutputRequest } {
	const parsed = parseWith(outputArgsSchema, value, "control.output()");
	return {
		ref: toRef(parsed.ref),
		request: {
			...(parsed.format === undefined ? {} : { format: parsed.format }),
			...(parsed.offset === undefined ? {} : { offset: parsed.offset }),
			...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
		},
	};
}

export function parseSendArgs(value: unknown): { readonly ref: HandleRef; readonly message: string } {
	const parsed = parseWith(sendArgsSchema, value, "control.send()");
	return { ref: toRef(parsed.ref), message: parsed.message };
}

export function refKey(ref: HandleRef): string {
	return `${ref.kind}:${ref.id}:${ref.run_epoch}`;
}

function toRef(value: Static<typeof handleRefSchema>): HandleRef {
	return { kind: value.kind, id: value.id, run_epoch: value.run_epoch };
}

function parseWith<T extends TSchema>(schema: T, value: unknown, helper: string): Static<T> {
	if (Check(schema, value)) return value;
	const summary = Errors(schema, value)
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
	throw new HandleArgumentsError(helper, summary || "invalid value");
}
