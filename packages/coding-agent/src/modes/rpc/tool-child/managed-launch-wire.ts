import { z } from "zod";

export const managedCommandSchema = z.object({
	command: z.string().min(1),
	args: z.array(z.string()),
	cwd: z.string(),
	env: z.record(z.string(), z.string().optional()),
	logPath: z.string(),
});

export type ManagedCommand = z.infer<typeof managedCommandSchema>;

export const managedLaunchReply = z.discriminatedUnion("type", [
	z.object({ type: z.literal("started"), pid: z.number().int().positive() }),
	z.object({ type: z.literal("completed"), exitCode: z.number().int() }),
	z.object({ type: z.literal("error"), message: z.string() }),
]);
