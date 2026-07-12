import { googleGeminiCliApi } from "../api/google-gemini-cli.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadGoogleAntigravityOAuth, loadGoogleGeminiCliOAuth } from "../utils/oauth/load.ts";
import { GOOGLE_ANTIGRAVITY_MODELS } from "./google-antigravity.models.ts";
import { GOOGLE_GEMINI_CLI_MODELS } from "./google-gemini-cli.models.ts";

const createGoogleCcaProvider = (
	id: "google-gemini-cli" | "google-antigravity",
	name: string,
	load: typeof loadGoogleGeminiCliOAuth,
	models: typeof GOOGLE_GEMINI_CLI_MODELS | typeof GOOGLE_ANTIGRAVITY_MODELS,
): Provider<"google-gemini-cli"> =>
	createProvider({
		id,
		name,
		baseUrl: "https://cloudcode-pa.googleapis.com",
		auth: { oauth: lazyOAuth({ name, load }) },
		models: Object.values(models),
		api: googleGeminiCliApi(),
	});

export const googleGeminiCliProvider = () =>
	createGoogleCcaProvider(
		"google-gemini-cli",
		"Google Gemini CLI",
		loadGoogleGeminiCliOAuth,
		GOOGLE_GEMINI_CLI_MODELS,
	);

export const googleAntigravityProvider = () =>
	createGoogleCcaProvider(
		"google-antigravity",
		"Google Antigravity",
		loadGoogleAntigravityOAuth,
		GOOGLE_ANTIGRAVITY_MODELS,
	);
