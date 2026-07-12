import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadCursorOAuth } from "../utils/oauth/load.ts";
import { CURSOR_MODELS } from "./cursor.models.ts";

export function cursorProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cursor",
		name: "Cursor",
		baseUrl: "https://api2.cursor.sh",
		auth: {
			apiKey: envApiKeyAuth("Cursor API key", ["CURSOR_API_KEY"]),
			oauth: lazyOAuth({ name: "Cursor (Claude, GPT, etc.)", load: loadCursorOAuth }),
		},
		models: Object.values(CURSOR_MODELS),
		api: openAICompletionsApi(),
	});
}
