// Package config persists the little the daemon must remember across restarts:
// which plane it belongs to and the long-lived credential it was issued. It is
// not state about the box — the box is the truth (#13).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// File is the on-disk form.
type File struct {
	Plane      string `json:"plane"`
	ServerID   string `json:"server_id,omitempty"`
	Credential string `json:"credential,omitempty"`
}

// DefaultPath is /etc/cockpitd/config.json when running as root, and a
// per-user path otherwise so --foreground development needs no privileges.
func DefaultPath() string {
	if os.Geteuid() == 0 {
		return "/etc/cockpitd/config.json"
	}

	dir, err := os.UserConfigDir()
	if err != nil {
		return "cockpitd.json"
	}

	return filepath.Join(dir, "cockpitd", "config.json")
}

// Load reads the config file. A missing file is not an error: it is a daemon
// that has not enrolled yet.
func Load(path string) (File, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return File{}, nil
	}

	if err != nil {
		return File{}, err
	}

	var f File

	if err := json.Unmarshal(b, &f); err != nil {
		return File{}, fmt.Errorf("parse %s: %w", path, err)
	}

	return f, nil
}

// Save writes the config file atomically with 0600 permissions: it holds a
// credential. Both the file and its parent directory are fsynced — a
// credential that a crash or power cut can lose strands the box, since the
// enrolment secret that produced it is already burned.
func Save(path string, f File) error {
	dir := filepath.Dir(path)

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}

	tmp := path + ".tmp"

	if err := writeSynced(tmp, append(b, '\n')); err != nil {
		return err
	}

	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)

		return err
	}

	// The rename itself is only durable once the directory entry is on disk.
	return syncDir(dir)
}

func writeSynced(path string, b []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}

	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(path)

		return err
	}

	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(path)

		return err
	}

	return f.Close()
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}

	if err := d.Sync(); err != nil {
		d.Close()

		return err
	}

	return d.Close()
}
