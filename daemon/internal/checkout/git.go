package checkout

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os/exec"
	"strings"
)

// baseEnv is the whole environment every git command runs with, built rather
// than inherited. The daemon's own environment is not a deployment's, and a
// box's /etc/gitconfig or a stray ~/.gitconfig can set a credential helper, a
// URL rewrite, or an http proxy — each of which decides where a fetch goes and
// who it presents. Nothing may prompt either: a daemon has no terminal, so a git
// that decides to ask would hang until its context expires.
func baseEnv() []string {
	return []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/nonexistent",
		"XDG_CONFIG_HOME=/nonexistent",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_CONFIG_GLOBAL=/dev/null",
		// Attributes decide which filters run over a checked-out file. The
		// repository's .gitattributes is part of the commit; the box's is not.
		"GIT_ATTR_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
		// Turns a document that finds a way to ask for ssh:// or ext:: into a
		// refusal rather than a connection.
		"GIT_ALLOW_PROTOCOL=https",
		// LFS would reach the network on checkout, with a credential this
		// environment does not have, for content outside the commit's objects.
		"GIT_LFS_SKIP_SMUDGE=1",
		"LC_ALL=C",
	}
}

// authConfigKey scopes the credential to GitHub over https. Git matches this key
// by URL prefix, so the header goes nowhere else.
const authConfigKey = "http.https://" + gitHost + "/.extraheader"

// fetchEnv is baseEnv plus the credential, and the only place in this package
// where the token becomes part of anything. Git reads config from the
// environment when GIT_CONFIG_COUNT is set, which is what makes this possible:
// in the URL the token would land in .git/config and FETCH_HEAD, in `git -c
// http.extraHeader=...` it would land in argv where every user on the box reads
// /proc, and in a credential helper it would land in a file.
func fetchEnv(token InstallationToken) []string {
	return append(baseEnv(),
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0="+authConfigKey,
		"GIT_CONFIG_VALUE_0=Authorization: Basic "+basicCredential(token),
	)
}

// basicCredential encodes the token the way GitHub takes an installation token
// over https: as the password of the fixed user x-access-token.
func basicCredential(token InstallationToken) string {
	return base64.StdEncoding.EncodeToString([]byte("x-access-token:" + string(token)))
}

// repoArgs pins the repository every command after init works on. Without them
// git discovers one by walking upwards, so a checkout path that was not
// initialized would answer for whatever repository is above it on the box.
func repoArgs(rest ...string) []string {
	return append([]string{"--git-dir=.git", "--work-tree=."}, rest...)
}

// initArgs creates the repository the fetch writes into. The object format
// follows the commit's length: a SHA-256 repository's objects cannot be fetched
// into a SHA-1 one. init.defaultBranch only silences advice.
func initArgs(commit string) []string {
	args := []string{"-c", "init.defaultBranch=main", "init", "--quiet"}
	if len(commit) == 64 {
		args = append(args, "--object-format=sha256")
	}

	return args
}

// fetchArgs fetches exactly one commit and nothing else — a deployment is one
// commit, so history, tags, and submodules are bandwidth for something nothing
// reads. Redirects are refused: git allows one by default, and a redirect moves
// the request — carrying the Authorization header this environment sets — to a
// host the caller never validated.
func fetchArgs(repoURL, commit string) []string {
	return repoArgs(
		"-c", "credential.helper=",
		"-c", "core.askPass=",
		"-c", "http.followRedirects=false",
		"fetch", "--quiet", "--no-tags", "--depth=1",
		"--no-recurse-submodules", "--no-write-fetch-head",
		repoURL, commit,
	)
}

func checkoutArgs(commit string) []string {
	return repoArgs("checkout", "--quiet", "--detach", commit)
}

// headArgs asks what is actually checked out. `^{commit}` because HEAD must
// resolve to a commit, not to a tag object or a tree.
func headArgs() []string {
	return repoArgs("rev-parse", "--verify", "--quiet", "HEAD^{commit}")
}

// execRun runs one git command and returns its stdout. The error names the
// command and its arguments, which is safe precisely because no argument here
// ever holds the token; the environment is never part of it.
func execRun(ctx context.Context, dir, name string, env, args []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = env

	var stdout, stderr bytes.Buffer

	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		ran := name + " " + strings.Join(args, " ")

		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			return nil, fmt.Errorf("%s: %w: %s", ran, err, detail)
		}

		return nil, fmt.Errorf("%s: %w", ran, err)
	}

	return stdout.Bytes(), nil
}
