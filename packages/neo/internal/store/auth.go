package store

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// AuthType is a provider's credential kind, mirroring the discriminant of
// AuthCredential (auth-storage.ts:24-34). ONLY the type is ever surfaced; key
// material is deliberately never decoded into any struct.
type AuthType string

const (
	// AuthTypeAPIKey mirrors ApiKeyCredential.type "api_key".
	AuthTypeAPIKey AuthType = "api_key"
	// AuthTypeOAuth mirrors OAuthCredential.type "oauth".
	AuthTypeOAuth AuthType = "oauth"
)

// AuthInfo is the presence/type map for auth.json. By construction it holds
// ONLY provider id -> credential type; it has no field capable of carrying a
// key, token, or any secret (security guardrail).
type AuthInfo struct {
	Providers map[string]AuthType
}

// HasProvider reports whether a credential exists for the provider id.
func (a AuthInfo) HasProvider(id string) bool {
	_, ok := a.Providers[id]
	return ok
}

// authEntry decodes ONLY the type discriminant of each credential. The key/
// oauth-token fields of the credential are intentionally omitted so no secret
// is ever read into memory.
type authEntry struct {
	Type string `json:"type"`
}

// LoadAuth reads <agentDir>/auth.json and returns the provider -> type map,
// mirroring AuthStorageData (auth-storage.ts:36). A missing file yields an
// empty map with no error. Unknown type strings are preserved as-is (presence
// is what the picker needs); key material is never surfaced.
func LoadAuth(agentDir string) (AuthInfo, error) {
	path := filepath.Join(agentDir, "auth.json")
	info := AuthInfo{Providers: map[string]AuthType{}}

	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return info, nil
		}
		return info, err
	}

	var raw map[string]authEntry
	if err := json.Unmarshal(b, &raw); err != nil {
		return info, err
	}
	for provider, entry := range raw {
		info.Providers[provider] = AuthType(entry.Type)
	}
	return info, nil
}
