package app

import (
	"encoding/json"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
)

// overlaybuild.go closes the "open-on-response" seam (plan todo 9e): a fetch-backed
// overlay is opened by issuing its RPC/native fetch and recording the pending kind;
// when the fetch lands (CommandResultMsg / SessionsScannedMsg) the concrete overlay
// is built from the payload and pushed. Local-data overlays (settings/theme/
// thinking/trust/hotkeys) need no fetch and are built + pushed immediately.

// overlayBuildContext carries the local state overlays are built from — kept on
// the Model and refreshed from the bootstrap get_state snapshot.
type overlayBuildContext struct {
	themes        []string
	currentModel  string // "provider/id"
	currentTheme  string
	thinkingLevel string
	autoCompact   bool
	favorites     overlays.FavoriteModelIDs
}

// openAppOverlay opens an app-kind overlay: fetch-backed kinds record the pending
// open and return the fetch command; local kinds build + push immediately.
func (m *Model) openAppOverlay(kind OverlayKind, savedText string) tea.Cmd {
	switch kind {
	case OverlayModel, OverlayFavorites, OverlayTree, OverlayStats:
		m.pendingOverlay = kind
		return m.overlayMgr().Open(kind)
	case OverlaySession:
		m.pendingOverlay = kind
		return m.overlayMgr().Open(kind) // scan_sessions FileOp → SessionsScannedMsg
	case OverlaySettings:
		return m.pushLocal(kind, buildSettingsModal(m.overlayCtx), savedText)
	case OverlayTheme:
		return m.pushLocal(kind, buildThemeSelector(m.overlayCtx), savedText)
	case OverlayThinking:
		return m.pushLocal(kind, buildThinkingSelector(m.overlayCtx), savedText)
	case OverlayTrust:
		return m.pushLocal(kind, overlays.NewTrustSelector(overlays.TrustOptions{CWD: m.requester.cwd}), savedText)
	case OverlayHotkeys:
		return m.pushLocal(kind, overlays.NewHotkeysView(m.keys), savedText)
	}
	return nil
}

// pushLocal pushes an immediately-built overlay through the manager.
func (m *Model) pushLocal(kind OverlayKind, ov Overlay, savedText string) tea.Cmd {
	m.overlayMgr().Push(kind, ov, savedText)
	return nil
}

// overlayMgr returns the underlying overlay Manager (the ExtUI decorates it).
func (m *Model) overlayMgr() *Manager { return m.extui.mgr }

// buildFetchedOverlay builds a fetch-backed overlay from its response. Returns
// (overlay, true) when the response matches the pending kind.
func (m *Model) buildFetchedOverlay(command string, resp bridge.Response) (Overlay, bool) {
	switch m.pendingOverlay {
	case OverlayModel:
		if command == "get_available_models" {
			return buildModelSelector(resp, m.overlayCtx), true
		}
	case OverlayFavorites:
		if command == "get_available_models" {
			return NewFavoritesOverlay(buildModelSelectorRaw(resp, m.overlayCtx)), true
		}
	case OverlayTree:
		if command == "get_tree" {
			return buildTree(resp, m.overlayCtx), true
		}
	case OverlayStats:
		if command == "get_session_stats" {
			return buildStats(resp), true
		}
	}
	return nil, false
}

// rpcModel mirrors one get_available_models entry (best-effort field set).
type rpcModel struct {
	Provider   string `json:"provider"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	AuthStatus struct {
		Configured bool `json:"configured"`
	} `json:"authStatus"`
}

func buildModelSelectorRaw(resp bridge.Response, ctx overlayBuildContext) *overlays.ModelSelector {
	var data struct {
		Models []rpcModel `json:"models"`
	}
	_ = json.Unmarshal(resp.Data, &data)
	items := make([]overlays.ModelItem, 0, len(data.Models))
	for _, mdl := range data.Models {
		auth := overlays.AuthMissing
		if mdl.AuthStatus.Configured {
			auth = overlays.AuthConfigured
		}
		items = append(items, overlays.ModelItem{Provider: mdl.Provider, ID: mdl.ID, Name: mdl.Name, AuthStatus: auth})
	}
	return overlays.NewModelSelector(overlays.ModelSelectorOptions{
		Models:       items,
		CurrentModel: ctx.currentModel,
		Favorites:    ctx.favorites,
	})
}

func buildModelSelector(resp bridge.Response, ctx overlayBuildContext) Overlay {
	return buildModelSelectorRaw(resp, ctx)
}

// rpcTreeNode mirrors one get_tree node (recursive).
type rpcTreeNode struct {
	ID       string        `json:"id"`
	Kind     string        `json:"kind"`
	Role     string        `json:"role"`
	Text     string        `json:"text"`
	Label    string        `json:"label"`
	Children []rpcTreeNode `json:"children"`
}

func (n rpcTreeNode) toNode() *overlays.TreeNode {
	node := &overlays.TreeNode{ID: n.ID, Kind: n.Kind, Role: n.Role, Text: n.Text, Label: n.Label}
	for _, c := range n.Children {
		node.Children = append(node.Children, c.toNode())
	}
	return node
}

func buildTree(resp bridge.Response, ctx overlayBuildContext) Overlay {
	var data struct {
		Root   rpcTreeNode `json:"root"`
		LeafID string      `json:"leafId"`
	}
	_ = json.Unmarshal(resp.Data, &data)
	return overlays.NewTreeNavigator(overlays.TreeOptions{Root: data.Root.toNode(), CurrentLeafID: data.LeafID})
}

func buildStats(resp bridge.Response) Overlay {
	var s overlays.SessionStats
	var data struct {
		SessionID    string `json:"sessionId"`
		SessionName  string `json:"sessionName"`
		MessageCount int    `json:"messageCount"`
		Model        string `json:"model"`
		CWD          string `json:"cwd"`
		Tokens       struct {
			Input  int `json:"input"`
			Output int `json:"output"`
		} `json:"tokens"`
	}
	if json.Unmarshal(resp.Data, &data) == nil {
		s = overlays.SessionStats{
			SessionID:    data.SessionID,
			SessionName:  data.SessionName,
			MessageCount: data.MessageCount,
			InputTokens:  data.Tokens.Input,
			OutputTokens: data.Tokens.Output,
			Model:        data.Model,
			CWD:          data.CWD,
		}
	}
	return overlays.NewSessionStats(s)
}

// buildSessionPicker builds the /resume picker from a native session scan.
func (m *Model) buildSessionPicker(sessions []store.SessionInfo) Overlay {
	return overlays.NewSessionPicker(overlays.SessionPickerOptions{
		Sessions:       sessions,
		ShowRenameHint: true,
		Keybindings:    m.keys,
	})
}

func buildSettingsModal(ctx overlayBuildContext) Overlay {
	return overlays.NewSettingsModal(overlays.SettingsModalOptions{
		CurrentTheme:    ctx.currentTheme,
		AvailableThemes: ctx.themes,
		AutoCompact:     ctx.autoCompact,
	})
}

func buildThemeSelector(ctx overlayBuildContext) Overlay {
	return overlays.NewThemeSelector(ctx.currentTheme, ctx.themes)
}

func buildThinkingSelector(ctx overlayBuildContext) Overlay {
	levels := []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}
	return overlays.NewThinkingSelector(ctx.thinkingLevel, levels)
}

// slashOverlayToApp maps a slash builtin's overlay intent onto the app overlay
// kind (or reports login/logout/unsupported specially via the second return).
func slashOverlayToApp(k slash.OverlayKind) (OverlayKind, slashOverlaySpecial) {
	switch k {
	case slash.OverlaySettings:
		return OverlaySettings, specialNone
	case slash.OverlayModel:
		return OverlayModel, specialNone
	case slash.OverlayFavoriteModels:
		return OverlayFavorites, specialNone
	case slash.OverlaySession:
		return OverlaySession, specialNone
	case slash.OverlayTree:
		return OverlayTree, specialNone
	case slash.OverlayTrust:
		return OverlayTrust, specialNone
	case slash.OverlayHotkeys:
		return OverlayHotkeys, specialNone
	case slash.OverlayLogin:
		return OverlayNone, specialLogin
	case slash.OverlayLogout:
		return OverlayNone, specialLogout
	default: // OverlayUserMessage (/fork) has no Go overlay yet
		return OverlayNone, specialUnsupported
	}
}

type slashOverlaySpecial int

const (
	specialNone slashOverlaySpecial = iota
	specialLogin
	specialLogout
	specialUnsupported
)
