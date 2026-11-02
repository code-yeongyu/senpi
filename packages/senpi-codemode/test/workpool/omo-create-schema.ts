import { z } from "zod";

// Copied from omo packages/senpi-task/src/workpool/schema.ts (the host's create contract): a strict object, so an
// option the host does not know (for example `context`) is refused, and `tools` is an optional list of names.
const nonempty = z.string().trim().min(1);
const WorkpoolAgentSchema = z.union([
	z.strictObject({ category: nonempty, prompt: nonempty, model: nonempty.optional() }),
	z.strictObject({ subagent_type: nonempty, prompt: nonempty, model: nonempty.optional() }),
]);
const WorkpoolCreateSchema = z.strictObject({
	name: nonempty,
	agent: WorkpoolAgentSchema,
	mode: z.enum(["fresh", "keep_alive"]).optional(),
	tools: z.array(nonempty).optional(),
});
export const WorkpoolCreateCommandSchema = WorkpoolCreateSchema.extend({ op: z.literal("create") });
