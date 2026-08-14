package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// awaiting_claim is the wire frame's own name (protocol section 3.3), so the
// file, the log and the plane say the same word for the same condition.
const (
	StateAwaitingClaim = protocol.TypeAwaitingClaim
	StateConnected     = "connected"
	StateDisconnected  = "disconnected"
)

// State is the daemon's live condition. It is ephemeral and never belongs in
// the config file: a claim code that outlives the process that offered it is a
// code the plane no longer holds.
type State struct {
	State string `json:"state"`
	// Unix seconds, as every other timestamp the daemon emits is.
	ClaimCode      string `json:"claim_code,omitempty"`
	ClaimExpiresAt int64  `json:"claim_expires_at,omitempty"`
	ServerID       string `json:"server_id,omitempty"`
	Plane          string `json:"plane"`
	Hostname       string `json:"hostname"`
}

// Readers that are not root need this by name: their own default resolves
// somewhere else entirely.
const RootStatePath = "/run/cockpitd/state.json"

// The root path is a tmpfs, so a reboot cannot leave a stale code behind, and
// the unit's RuntimeDirectory= creates and removes it. The per-user path is so
// --foreground development needs no privileges.
func StatePath() string {
	if os.Geteuid() == 0 {
		return RootStatePath
	}

	dir, err := os.UserConfigDir()
	if err != nil {
		return "cockpitd-state.json"
	}

	return filepath.Join(dir, "cockpitd", "state.json")
}

// 0600 because an unredeemed claim code is a secret that binds this box to a
// plane. No fsync, unlike Save: /run is a tmpfs and the file is meaningless
// across a reboot, but the rename still keeps a reader from seeing a partial
// write.
func SaveState(path string, s State) error {
	dir := filepath.Dir(path)

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}

	tmp := path + ".tmp"

	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}

	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)

		return err
	}

	return nil
}

// A missing file is returned as the os error it is: it means the daemon is not
// running, which is a different answer from any state it could have published.
func LoadState(path string) (State, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return State{}, err
	}

	var s State

	if err := json.Unmarshal(b, &s); err != nil {
		return State{}, fmt.Errorf("parse %s: %w", path, err)
	}

	return s, nil
}
