/**
 * Model-id families Cursor accepts images for. `GetUsableModels` carries no
 * modality field, so this follows AvailableModels' `supportsImages` flag
 * (live capture 2026-10-18, senpi#3620): Auto (`default`), Kimi K3, Muse and
 * Grok 4.5/4.6 take images; Composer, Kimi K2.7 Code, Grok 4.7 and `grok-code-*` do not.
 */
const CURSOR_MULTIMODAL_ID_PATTERN = /^default$|claude|gemini|gpt-|codex|kimi-k3|muse-|cursor-grok-4\.[56]/;

export function cursorDiscoveredInput(modelId: string): ("text" | "image")[] {
	return CURSOR_MULTIMODAL_ID_PATTERN.test(modelId.toLowerCase()) ? ["text", "image"] : ["text"];
}
