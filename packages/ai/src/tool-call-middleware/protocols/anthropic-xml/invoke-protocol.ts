import type { Tool } from "../../../types.ts";
import { coerceParameters } from "./coerce-parameters.ts";
import type { InvokeParameter } from "./invoke-tag-scanner.ts";

/**
 * Behavior knobs shared by every `<invoke>`/`<parameter>`-shaped protocol.
 * The scanner, batch parser, and stream parser are format-agnostic; a config
 * supplies the protocol identity and the schema-aware argument coercion.
 */
export type InvokeProtocolConfig = {
	/** Wire-format identifier reported in onError metadata. */
	readonly protocol: string;
	/** Human-readable protocol label used in error messages. */
	readonly label: string;
	/** Tool-call id prefix; ids are `${idPrefix}-${index}`. */
	readonly idPrefix: string;
	/** Schema-aware parameter coercion for structurally complete invokes. */
	readonly coerce: (parameters: readonly InvokeParameter[], tool: Tool) => Record<string, unknown> | null;
};

export const anthropicXmlInvokeConfig: InvokeProtocolConfig = {
	protocol: "anthropic-xml",
	label: "Anthropic XML",
	idPrefix: "anthropic-xml-tool",
	coerce: coerceParameters,
};
