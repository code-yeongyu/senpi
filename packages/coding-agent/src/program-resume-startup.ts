// senpi#7493: the CLI's first import. Under Bun the OSC 7577 token has to leave the startup environment before any
// other module runs, because everything evaluated before the in-place exec runs again after it.
import { handOffProgramResumeToken } from "./private-fd-token-handoff.ts";

await handOffProgramResumeToken();
