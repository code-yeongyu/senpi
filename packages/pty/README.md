# @earendil-works/pi-pty

Typed loader package for Senpi PTY sessions.

The current scaffold exposes `PtySession` and a native loader result. Until host prebuilds are added, `loadPtyNative()` returns `native: null` with a `native-unavailable` diagnostic for the attempted host path.
