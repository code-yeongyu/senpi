import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { fromConfig } from "./permission.js";
import type { PermissionConfig, Ruleset } from "./types.js";

export const AgentModeSchema = Type.Union([Type.Literal("subagent"), Type.Literal("primary"), Type.Literal("all")]);
export type AgentMode = Static<typeof AgentModeSchema>;

const ToolActionSchema = Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("ask")]);

const ToolPermissionValueSchema = Type.Union([ToolActionSchema, Type.Record(Type.String(), ToolActionSchema)]);

export const AgentFrontmatterSchema = Type.Object({
	description: Type.Optional(Type.String()),
	mode: Type.Optional(AgentModeSchema),
	model: Type.Optional(Type.String()),
	temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
	tools: Type.Optional(Type.Record(Type.String(), ToolPermissionValueSchema)),
	disable: Type.Optional(Type.Boolean()),
});
export type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>;

const CompiledAgentFrontmatterSchema = Compile(AgentFrontmatterSchema);

export type AgentInfo = {
	name: string;
	description?: string;
	mode: AgentMode;
	model?: string;
	temperature?: number;
	prompt?: string;
	permission: Ruleset;
	native: boolean;
};

export function validateAgentConfig(name: string, frontmatter: AgentFrontmatter, body: string): AgentInfo | Error {
	const isValid = CompiledAgentFrontmatterSchema.Check(frontmatter);
	if (!isValid) {
		const errors = CompiledAgentFrontmatterSchema.Errors(frontmatter);
		const errorMessages = [];
		for (const error of errors) {
			errorMessages.push(`${error.instancePath}: ${error.message}`);
		}
		return new Error(`Invalid agent config: ${errorMessages.join(", ")}`);
	}

	const agentInfo: AgentInfo = {
		name,
		description: frontmatter.description,
		mode: frontmatter.mode ?? "all",
		model: frontmatter.model,
		temperature: frontmatter.temperature,
		prompt: body,
		permission: fromConfig((frontmatter.tools ?? {}) as PermissionConfig),
		native: false,
	};

	return agentInfo;
}
