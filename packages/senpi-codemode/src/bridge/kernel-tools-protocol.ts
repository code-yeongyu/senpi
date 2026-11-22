import { type Static, Type } from "typebox";

/** Payload of a `kernel_tool_host_denied` refusal: the host tool, the invoking call, the reason (#1731). */
const kernelToolHostDenialSchema = Type.Object({
	tool: Type.String({ minLength: 1 }),
	call_id: Type.String({ minLength: 1 }),
	reason: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
});

const kernelToolErrorSchema = Type.Object({
	message: Type.String(),
	name: Type.Optional(Type.String()),
	stack: Type.Optional(Type.String()),
	code: Type.Optional(Type.String()),
	details: Type.Optional(kernelToolHostDenialSchema),
});

/** Per-call execution scope for the nested host calls the invoked closure makes (#1731). */
export const kernelToolInvokeScopeSchema = Type.Object({
	tools: Type.Optional(
		Type.Object({
			allow: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			deny: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		}),
	),
});

export const kernelToolDescriptorSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	description: Type.String(),
	input_schema: Type.Unknown(),
	language: Type.Union([Type.Literal("js"), Type.Literal("py"), Type.Literal("rb"), Type.Literal("jl")]),
	kernel_generation: Type.Integer({ minimum: 0 }),
	definition_revision: Type.Integer({ minimum: 1 }),
});

const describeResultSchema = Type.Union([
	Type.Object({
		name: Type.String({ minLength: 1 }),
		ok: Type.Literal(true),
		descriptor: kernelToolDescriptorSchema,
	}),
	Type.Object({
		name: Type.String({ minLength: 1 }),
		ok: Type.Literal(false),
		error: kernelToolErrorSchema,
	}),
]);

export const kernelToolHostToKernelSchemas = [
	Type.Object({
		type: Type.Literal("kernel-tool-describe"),
		requestId: Type.String({ minLength: 1 }),
		names: Type.Array(Type.String({ minLength: 1 })),
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-invoke"),
		requestId: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		kernel_generation: Type.Integer({ minimum: 0 }),
		definition_revision: Type.Integer({ minimum: 1 }),
		args: Type.Unknown(),
		call_id: Type.String({ minLength: 1 }),
		scope: Type.Optional(kernelToolInvokeScopeSchema),
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-cancel"),
		requestId: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		type: Type.Literal("kernel-tools-names"),
		hostToolNames: Type.Array(Type.String({ minLength: 1 })),
		foreignLanguageNames: Type.Array(Type.String({ minLength: 1 })),
	}),
] as const;

export const kernelToolKernelToHostSchemas = [
	Type.Object({
		type: Type.Literal("kernel-tool-describe-reply"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Literal(true),
		results: Type.Array(describeResultSchema),
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-describe-reply"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Literal(false),
		error: kernelToolErrorSchema,
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-invoke-reply"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Literal(true),
		value: Type.Unknown(),
		/** Python: text the tool printed during this call (never the parent cell's output). */
		output: Type.Optional(Type.String()),
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-invoke-reply"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Literal(false),
		error: kernelToolErrorSchema,
		output: Type.Optional(Type.String()),
	}),
	/** Python: the kernel's tool names after a define or undefine, for cross-language collision checks. */
	Type.Object({
		type: Type.Literal("kernel-tools-defined"),
		names: Type.Array(Type.String({ minLength: 1 })),
	}),
] as const;

export type KernelToolDescriptorMessage = Static<typeof kernelToolDescriptorSchema>;
