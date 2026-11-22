# @earendil-works/pi-realm-registry

One pinned, versioned registry instance per JavaScript realm (omo#12965). senpi's engine modules keep every table that one
engine copy writes and another reads behind `realmRegistry(keyName, create, isV1)`, so a second copy of the engine in
the same process shares the table instead of keeping a private one. Private workspace package; published as
`@code-yeongyu/senpi-realm-registry` with pi-ai and vendored into the engine tarball.
