# @earendil-works/pi-pty

Typed loader package for Senpi PTY sessions.

The package exposes `PtySession` and a native loader result. `loadPtyNative()` searches the shipped `native/prebuilds/<platform>-<arch>/` package layout and returns the loaded binding when a matching prebuild is present. Unsupported hosts return `native: null` with a `native-unavailable` diagnostic for the attempted host paths.
