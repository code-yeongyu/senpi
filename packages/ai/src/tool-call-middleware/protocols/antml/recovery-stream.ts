import type { Tool } from "../../../types.ts";
import type { ParserOptions } from "../../types.ts";
import { createInvokeRecoveryStreamParser, type RecoveryStreamParser } from "../anthropic-xml/recovery-stream.ts";
import { antmlInvokeConfig } from "./config.ts";

export function createAntmlInvokeRecoveryStreamParser(
	tools: readonly Tool[],
	options?: ParserOptions,
): RecoveryStreamParser {
	return createInvokeRecoveryStreamParser(tools, antmlInvokeConfig, options);
}
