export const BROWSER_ENGINES = ["connected", "builtin", "none"] as const;

/** Which browser a session's skills drive: the user's own, the app's built-in one, or none. */
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];

/** The variable a session's tool subprocesses and eval kernels read the engine from. */
export const BROWSER_ENGINE_ENV = "OMO_BROWSER_ENGINE";

export function isBrowserEngine(value: unknown): value is BrowserEngine {
	return BROWSER_ENGINES.some((engine) => engine === value);
}
