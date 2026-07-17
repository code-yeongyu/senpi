import type { Tool } from "../../../types.ts";
import type { ParsedToolCall, ParserOptions } from "../../types.ts";
import { parseInvokeGeneratedText } from "../anthropic-xml/parse.ts";
import { antmlInvokeConfig } from "./config.ts";

export function parseAntmlGeneratedText(text: string, tools: Tool[], options?: ParserOptions): ParsedToolCall[] {
	return parseInvokeGeneratedText(text, tools, antmlInvokeConfig, options);
}
