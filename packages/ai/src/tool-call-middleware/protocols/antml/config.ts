import type { InvokeProtocolConfig } from "../anthropic-xml/invoke-protocol.ts";
import { coerceAntmlParameters } from "./coerce-parameters.ts";

export const antmlInvokeConfig: InvokeProtocolConfig = {
	protocol: "antml",
	label: "antml",
	idPrefix: "antml-tool",
	coerce: coerceAntmlParameters,
};
