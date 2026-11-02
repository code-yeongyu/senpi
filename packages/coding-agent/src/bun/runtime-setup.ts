import { APP_NAME } from "../config.ts";
import { registerBunRuntimeModules } from "./runtime-modules.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunRuntimeModules();
