import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleGeminiCliApi = (): ProviderStreams => lazyApi(() => import("./google-gemini-cli.ts"));
