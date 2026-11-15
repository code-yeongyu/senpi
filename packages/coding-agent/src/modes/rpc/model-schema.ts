import type { Api, Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import { count } from "./agent-message-schema.ts";

// The hand's parse of a model a hosted loop sends with `model_select` and `system_prompt_change` (senpi#5898): the
// fields its readers rely on. Objects are loose, except that a model never carries `headers`: a model's own headers
// can carry a credential and never leave the side that dials (CK21, `hand/hook-contract.ts`), so one is refused.

const modelSchema = z
	.looseObject({
		id: z.string(),
		name: z.string(),
		api: z.string(),
		provider: z.string(),
		baseUrl: z.string(),
		reasoning: z.boolean(),
		input: z.array(z.string()),
		cost: z.looseObject({ input: count, output: count, cacheRead: count, cacheWrite: count }),
		contextWindow: count,
		maxTokens: count,
	})
	.refine((model) => !("headers" in model));

export const isModel = (value: unknown): value is Model<Api> => modelSchema.safeParse(value).success;
