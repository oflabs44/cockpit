package checkout

// The environment git is given: fixed, scrubbed of the box, and the one place
// the credential lives.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The list itself, spelled out here rather than read from the package, so a
// variable can only be added to what git sees deliberately.
var wantBaseEnv = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/nonexistent",
	"XDG_CONFIG_HOME=/nonexistent",
	"GIT_CONFIG_NOSYSTEM=1",
	"GIT_CONFIG_SYSTEM=/dev/null",
	"GIT_CONFIG_GLOBAL=/dev/null",
	"GIT_ATTR_NOSYSTEM=1",
	"GIT_TERMINAL_PROMPT=0",
	"GIT_ASKPASS=",
	"SSH_ASKPASS=",
	"GIT_ALLOW_PROTOCOL=https",
	"GIT_LFS_SKIP_SMUDGE=1",
	"LC_ALL=C",
}

func TestBaseEnvIsFixed(t *testing.T) {
	if got := baseEnv(); !reflect.DeepEqual(got, wantBaseEnv) {
		t.Fatalf("env =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(wantBaseEnv, "\n"))
	}
}

// The daemon's environment is not the deployment's. A secret in the process
// that started cockpitd must not be readable by git, by a hook, or by anything
// git starts.
func TestBaseEnvDoesNotInheritTheDaemonEnvironment(t *testing.T) {
	const secret = "cockpit-daemon-secret-value"

	t.Setenv("GITHUB_TOKEN", secret)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.pager")
	t.Setenv("GIT_CONFIG_VALUE_0", secret)

	for _, entry := range baseEnv() {
		if strings.Contains(entry, secret) {
			t.Fatalf("the daemon environment leaked into git: %q", entry)
		}
	}
}

// A SHA-256 commit needs a SHA-256 repository: its objects cannot be fetched
// into a SHA-1 one.
func TestObjectFormatFollowsTheCommit(t *testing.T) {
	if got := initArgs(strings.Repeat("a", 64)); got[len(got)-1] != "--object-format=sha256" {
		t.Errorf("init args for a sha-256 commit = %v", got)
	}

	if got := strings.Join(initArgs(testCommit), " "); strings.Contains(got, "object-format") {
		t.Errorf("init args for a sha-1 commit = %v", got)
	}
}

// Against real git, offline: the box's own configuration is not read, and the
// credential the fetch is given does arrive. Both halves are assertions about
// git's behaviour rather than this package's, so they are worth making against
// the real thing — and neither needs a network.
func TestRealGitIsScrubbedAndReadsTheCredentialFromTheEnvironment(t *testing.T) {
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("no git on PATH")
	}

	// A hostile box: a global config with a credential helper and a URL
	// rewrite, and an ambient environment config. None of it may reach git.
	home := t.TempDir()

	const hostile = "[credential]\n\thelper = leaked\n[url \"https://evil.test/\"]\n\tinsteadOf = https://github.com/\n"
	if err := os.WriteFile(filepath.Join(home, ".gitconfig"), []byte(hostile), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "credential.helper")
	t.Setenv("GIT_CONFIG_VALUE_0", "leaked")

	dir := t.TempDir()

	if _, err := execRun(context.Background(), dir, gitBin, baseEnv(), initArgs(testCommit)); err != nil {
		t.Fatal(err)
	}

	listed, err := execRun(context.Background(), dir, gitBin, baseEnv(), repoArgs("config", "--list"))
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(listed), "leaked") || strings.Contains(string(listed), "evil.test") {
		t.Errorf("git read the box's configuration:\n%s", listed)
	}

	header, err := execRun(context.Background(), dir, gitBin, fetchEnv(testToken),
		repoArgs("config", "--get", authConfigKey))
	if err != nil {
		t.Fatalf("git did not receive the credential: %v", err)
	}

	// Compared, never printed: this value is the credential.
	if strings.TrimSpace(string(header)) != "Authorization: Basic "+basicCredential(testToken) {
		t.Errorf("git received a different %s than the one the fetch was given", authConfigKey)
	}
}
