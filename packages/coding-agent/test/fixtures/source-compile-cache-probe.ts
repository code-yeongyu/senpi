import { getCompileCacheDir } from "node:module";

process.stdout.write(getCompileCacheDir() ?? "");
