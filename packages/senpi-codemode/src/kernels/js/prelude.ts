export const JAVASCRIPT_KERNEL_PRELUDE = [
	"print(...values): write stdout text.",
	"display(value): emit JSON or image display output.",
	"log(message): emit a progress log line.",
	"phase(title): emit a progress phase.",
	"env(key?, value?): read, set, or list environment values.",
	"read(path, offset?, limit?): read UTF-8 text with optional 1-indexed line slicing.",
	"write(path, content): write UTF-8 text and return the resolved path.",
	"tool.<name>(args): request a host tool call through the bridge.",
	"completion(prompt, opts?): request a host completion bridge call.",
	"parallel(thunks): run async thunks through the configured bounded pool.",
	"pipeline(items, ...stages): map items through staged async transforms.",
].join("\n");
