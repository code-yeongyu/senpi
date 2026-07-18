import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const cursorConnectApi = (): ProviderStreams =>
	lazyApi(() => import("./cursor-connect.ts").then((m) => m.cursorConnectStreams));
