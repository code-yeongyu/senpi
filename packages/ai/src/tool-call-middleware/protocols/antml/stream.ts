import type { Tool } from "../../../types.ts";
import type { ParserOptions, StreamParser } from "../../types.ts";
import { createInvokeStreamParser } from "../anthropic-xml/stream.ts";
import { antmlInvokeConfig } from "./config.ts";

export function createAntmlStreamParser(tools: Tool[], options?: ParserOptions): StreamParser {
	return createInvokeStreamParser(tools, antmlInvokeConfig, options);
}
