import { url as inspectorUrl } from "node:inspector";
import { pathToFileURL } from "node:url";

const [cliPath, ...cliArgs] = process.argv.slice(2);
if (!cliPath) throw new Error("Expected a CLI source path");

const activeInspectorUrl = inspectorUrl();
if (!activeInspectorUrl) throw new Error("Expected an active Inspector");

process.env.NODE_OPTIONS = `--inspect=127.0.0.1:${new URL(activeInspectorUrl).port}`;
process.argv = [process.execPath, cliPath, ...cliArgs];
await import(pathToFileURL(cliPath).href);
