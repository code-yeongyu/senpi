/**
 * Side-effect entry: releases a coordinated start's inherited filler pipes (senpi#4602) while the #4749 private
 * descriptor table is still in the environment. An entry imports this BEFORE `private-fds.ts`, which removes the
 * table from the environment when it adopts it; released after that, a slot the table names would look like a
 * filler and be closed.
 */
import { releaseInheritedStartupFillers } from "./private-fd-startup-fillers.ts";

releaseInheritedStartupFillers(process.env);
