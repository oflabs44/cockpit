package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/config"
)

func quietLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func tokenFile(t *testing.T, contents string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "enrolment-token")

	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}

	return path
}

func TestResolveToken(t *testing.T) {
	tests := []struct {
		name      string
		token     string
		file      string
		want      string
		wantError string
	}{
		{name: "neither"},
		{name: "flag only", token: "ck_enrol_once", want: "ck_enrol_once"},
		{
			// A token in a file is written by install.sh, and an editor or a
			// shell redirect leaves a newline on the end of it.
			name: "file is trimmed",
			file: tokenFile(t, "ck_enrol_once\n"),
			want: "ck_enrol_once",
		},
		{
			// The file is unlinked the moment the token is burned, so this is
			// what every restart after a successful enrolment looks like.
			name: "missing file is not an error",
			file: filepath.Join(t.TempDir(), "gone"),
		},
		{
			name:      "both",
			token:     "ck_enrol_once",
			file:      tokenFile(t, "ck_enrol_once"),
			wantError: "not both",
		},
		{
			// Not the same as no file, which means burned. Falling through to
			// the claim flow here would print a code at whoever was waiting
			// for an enrolment that can now never happen.
			name:      "empty file",
			file:      tokenFile(t, "\n  \n"),
			wantError: "is empty",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveToken(tc.token, tc.file, quietLog())

			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("err = %v, want one mentioning %q", err, tc.wantError)
				}

				return
			}

			if err != nil {
				t.Fatal(err)
			}

			if got != tc.want {
				t.Fatalf("token = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestUnusableTokenIsBurnedAtStartup(t *testing.T) {
	// install.sh died before its own cleanup, so a spent single-use secret is
	// still sitting in /etc. This daemon holds a credential, so secret()
	// prefers it forever and the token would otherwise never be reached by the
	// burn — it would just sit there for the life of the box.
	path := tokenFile(t, "ck_enrol_once")
	cfg := config.File{Credential: "ck_cred_live", ServerID: "srv_1"}

	if got := discardUnusableToken(cfg, "ck_enrol_once", path, quietLog()); got != "" {
		t.Fatalf("enrolment secret = %q, want it discarded", got)
	}

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stat err = %v, want the token gone", err)
	}
}

func TestUsableTokenIsKept(t *testing.T) {
	path := tokenFile(t, "ck_enrol_once")

	if got := discardUnusableToken(config.File{}, "ck_enrol_once", path, quietLog()); got != "ck_enrol_once" {
		t.Fatalf("enrolment secret = %q, want it kept for a daemon with no credential", got)
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat err = %v, want the token still there", err)
	}
}

func TestBurnTokenFileRemovesTheSpentToken(t *testing.T) {
	path := tokenFile(t, "ck_enrol_once")

	burnTokenFile(path, quietLog())

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stat err = %v, want the file gone", err)
	}
}

func TestTokenIsBurnedOnlyAfterTheCredentialIsOnDisk(t *testing.T) {
	path := tokenFile(t, "ck_enrol_once")
	cfgPath := filepath.Join(t.TempDir(), "config.json")
	cfg := config.File{Plane: "https://plane.test"}

	if err := persistCredential(cfgPath, &cfg, path, quietLog())("srv_1", "ck_cred_live"); err != nil {
		t.Fatal(err)
	}

	saved, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}

	if saved.ServerID != "srv_1" || saved.Credential != "ck_cred_live" {
		t.Fatalf("config = %+v, want the issued identity", saved)
	}

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stat err = %v, want the token burned", err)
	}
}

func TestTokenSurvivesAFailedCredentialWrite(t *testing.T) {
	path := tokenFile(t, "ck_enrol_once")
	// A config path whose parent is a regular file: the credential never lands,
	// so the token that bought it is the only way back and must still be there.
	blocked := filepath.Join(t.TempDir(), "blocked")

	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	cfgPath := filepath.Join(blocked, "config.json")
	cfg := config.File{}

	if err := persistCredential(cfgPath, &cfg, path, quietLog())("srv_1", "ck_cred_live"); err == nil {
		t.Fatal("err = nil, want the config write to fail")
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat err = %v, want the token still on disk", err)
	}
}

func TestBurnTokenFileToleratesAnAlreadyGoneFile(t *testing.T) {
	// A restart between the credential landing and the unlink lands here, and
	// re-burning must not take the daemon down with it.
	burnTokenFile(filepath.Join(t.TempDir(), "gone"), quietLog())
	burnTokenFile("", quietLog())
}
