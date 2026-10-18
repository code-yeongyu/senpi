import { afterAll } from "vitest";
import { cleanupTempDirs } from "./vitest-temp.ts";

afterAll(cleanupTempDirs);
