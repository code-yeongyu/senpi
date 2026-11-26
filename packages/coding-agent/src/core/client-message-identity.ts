import type { ImageContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { InputSource } from "./extensions/types.ts";

export const clientMessageIdentitySchema = z.object({
	clientMessageId: z.string().min(1).max(256).optional(),
	clientTurnId: z.string().min(1).max(256).optional(),
});

export type ClientMessageIdentity = Readonly<z.infer<typeof clientMessageIdentitySchema>>;

export type PreparedClientInput = ClientMessageIdentity & {
	readonly text: string;
	readonly images?: ImageContent[];
	readonly mode: "steer" | "followUp";
	readonly enqueueOrder: number;
	/** The input's `input` event source, kept so restored input is re-stamped with it. Absent: unknown origin. */
	readonly source?: InputSource;
};

/** Copy only correlation metadata, never the rest of a prompt's options. */
export function clientMessageIdentity(value: ClientMessageIdentity = {}): ClientMessageIdentity {
	return {
		...(value.clientMessageId === undefined ? {} : { clientMessageId: value.clientMessageId }),
		...(value.clientTurnId === undefined ? {} : { clientTurnId: value.clientTurnId }),
	};
}

export function readClientMessageIdentity(value: unknown): ClientMessageIdentity {
	const parsed = clientMessageIdentitySchema.safeParse(value);
	return parsed.success ? clientMessageIdentity(parsed.data) : {};
}
