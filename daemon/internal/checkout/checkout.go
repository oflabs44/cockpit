// Package checkout puts one deployment's exact commit on the box.
//
// Prepare takes a deployment id, a canonical GitHub clone URL, a full commit id,
// and a short-lived installation token, and returns a directory whose HEAD is
// verified to be that commit. It resolves nothing: a branch, a tag, or an
// abbreviation is not a deployment input, because the Plane decides which commit
// a deployment is and records it (ADR-0012).
//
// The token lives in this process's memory and in the environment of the one
// fetch subprocess, and nowhere else: not in argv, not in the fetch URL, not in
// anything git writes under .git, not in the result, and not in any error.
//
// The tree is world-readable under private parents. Compose normalization reads
// it through a bind mount as an unmapped user, and a mount is resolved at the
// mountpoint, so the tree is readable to it and to nobody else on the box
// (internal/compose/sandbox.go).
package checkout

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// DefaultRoot is under /run because a checkout costs one fetch to reproduce and
// must not survive a reboot as a stale tree nobody chose.
const DefaultRoot = "/run/cockpitd/deployments"

const (
	// checkoutDir keeps the deployment's own scratch space outside the tree.
	checkoutDir = "checkout"
	// markerFile records the commit of a checkout that finished every step. HEAD
	// alone cannot: an interrupted run leaves a tree that is checked out but whose
	// modes were never fixed.
	markerFile = "commit"
)

const (
	privateDirMode fs.FileMode = 0o700
	publicDirMode  fs.FileMode = 0o755
	fileMode       fs.FileMode = 0o644
	execFileMode   fs.FileMode = 0o755
	markerMode     fs.FileMode = 0o600
)

// InstallationToken is a GitHub App installation token: short-lived, issued for
// one fetch, never stored (ADR-0012). String and GoString redact it, so the
// ordinary accident — a %v, a %s, a log field — cannot spend it.
type InstallationToken string

const redacted = "<redacted>"

func (InstallationToken) String() string { return redacted }

func (InstallationToken) GoString() string { return redacted }

// Runner runs one git command and returns its stdout. env is the child's whole
// environment, passed in rather than inherited, because it is the only place the
// token appears; a runner that retains what it is given must redact it.
type Runner func(ctx context.Context, dir, name string, env, args []string) ([]byte, error)

// Checkout prepares deployment working trees under one runtime root.
type Checkout struct {
	Root string // empty means DefaultRoot
	Bin  string // empty means git on PATH
	Run  Runner // injected so the whole flow is testable without git
}

// New returns a Checkout using the git binary on PATH and the default root.
func New() *Checkout {
	return &Checkout{Root: DefaultRoot, Bin: "git", Run: execRun}
}

// Request is one deployment's source. Every field is validated before git runs.
type Request struct {
	DeploymentID string // becomes a path segment, so it is checked as one
	RepoURL      string // https://github.com/{owner}/{repo}.git and nothing else
	Commit       string // full SHA: 40 hex digits, or 64 for SHA-256
}

// Result is a prepared checkout. Commit is read back out of the repository
// rather than echoed from the request.
type Result struct {
	Dir    string
	Commit string
}

// Prepare returns a checkout of req.Commit at a stable path for
// req.DeploymentID. Re-preparing the same deployment at the same commit verifies
// what is there and returns it; anything else at that path — a different commit,
// a tree an interrupted run left half-written — is replaced. token is used for
// exactly one subprocess, the fetch.
func (c *Checkout) Prepare(ctx context.Context, req Request, token InstallationToken) (Result, error) {
	valid, err := validate(req)
	if err != nil {
		return Result{}, err
	}

	if token == "" {
		return Result{}, errors.New("prepare checkout: no installation token")
	}

	if c.Run == nil {
		return Result{}, errors.New("prepare checkout: no command runner")
	}

	deployment, err := c.layout(valid.deploymentID)
	if err != nil {
		return Result{}, err
	}

	dir := filepath.Join(deployment, checkoutDir)
	marker := filepath.Join(deployment, markerFile)

	// The marker says a previous run got all the way through; HEAD says the tree
	// is still that commit. Either alone would accept an interrupted run.
	if readMarker(marker) == valid.commit {
		if head, err := c.head(ctx, dir); err == nil && head == valid.commit {
			return Result{Dir: dir, Commit: head}, nil
		}
	}

	// From here the tree is being rebuilt, so nothing may claim it is finished.
	if err := os.Remove(marker); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return Result{}, fmt.Errorf("prepare checkout: %w", err)
	}

	if err := replace(dir); err != nil {
		return Result{}, err
	}

	if err := c.fetchCommit(ctx, dir, valid, token); err != nil {
		return Result{}, err
	}

	// What the deployment builds is what git says is checked out, not what the
	// request asked for.
	head, err := c.head(ctx, dir)
	if err != nil {
		return Result{}, err
	}

	if head != valid.commit {
		return Result{}, fmt.Errorf(
			"prepare checkout: HEAD is %s after checking out %s", head, valid.commit)
	}

	if err := fixModes(dir); err != nil {
		return Result{}, err
	}

	if err := os.WriteFile(marker, []byte(head), markerMode); err != nil {
		return Result{}, fmt.Errorf("prepare checkout: %w", err)
	}

	return Result{Dir: dir, Commit: head}, nil
}

func (c *Checkout) fetchCommit(ctx context.Context, dir string, valid request, token InstallationToken) error {
	if _, err := c.git(ctx, dir, baseEnv(), initArgs(valid.commit)); err != nil {
		return fmt.Errorf("prepare checkout: init repository: %w", err)
	}

	if _, err := c.git(ctx, dir, fetchEnv(token), fetchArgs(valid.repoURL, valid.commit)); err != nil {
		// Nothing this package puts in that error holds the token. Scrubbed anyway:
		// git's own message is not this package's to audit, and the failure mode is
		// a credential in a deployment log.
		return scrub(fmt.Errorf("prepare checkout: fetch %s at %s: %w", valid.repoURL, valid.commit, err), token)
	}

	if _, err := c.git(ctx, dir, baseEnv(), checkoutArgs(valid.commit)); err != nil {
		return fmt.Errorf("prepare checkout: check out %s: %w", valid.commit, err)
	}

	return nil
}

// head returns the commit the working tree is at. Every failure means the same
// thing to the caller — this is not a verified checkout.
func (c *Checkout) head(ctx context.Context, dir string) (string, error) {
	out, err := c.git(ctx, dir, baseEnv(), headArgs())
	if err != nil {
		return "", fmt.Errorf("prepare checkout: read HEAD: %w", err)
	}

	head := strings.TrimSpace(string(out))
	if !isCommitSHA(head) {
		return "", fmt.Errorf("prepare checkout: HEAD is not a commit id: %q", head)
	}

	return head, nil
}

func (c *Checkout) git(ctx context.Context, dir string, env, args []string) ([]byte, error) {
	bin := c.Bin
	if bin == "" {
		bin = "git"
	}

	return c.Run(ctx, dir, bin, env, args)
}

func readMarker(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	return strings.TrimSpace(string(content))
}

// scrub removes the token from an error's text: the backstop for the paths that
// are not this package's to audit.
func scrub(err error, token InstallationToken) error {
	if err == nil || token == "" {
		return err
	}

	message := err.Error()

	cleaned := strings.ReplaceAll(message, string(token), redacted)
	cleaned = strings.ReplaceAll(cleaned, basicCredential(token), redacted)

	if cleaned == message {
		return err
	}

	return &redactedError{message: cleaned, cause: err}
}

type redactedError struct {
	message string
	cause   error
}

func (e *redactedError) Error() string { return e.message }

func (e *redactedError) Unwrap() error { return e.cause }

// layout creates the runtime root and this deployment's private directory and
// returns the latter. This is the only place a deployment path is composed.
func (c *Checkout) layout(deploymentID string) (string, error) {
	root := c.Root
	if root == "" {
		root = DefaultRoot
	}

	// A relative root would compose a path from the daemon's working directory,
	// and this package removes things beneath that path.
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("prepare checkout: the runtime root %q is not absolute", root)
	}

	deployment := filepath.Join(root, deploymentID)

	for _, dir := range []string{root, deployment} {
		if err := os.MkdirAll(dir, privateDirMode); err != nil {
			return "", fmt.Errorf("prepare checkout: %w", err)
		}

		// Checked before the chmod, never after: chmod follows a symlink, so a link
		// here would set 0700 on whatever it names.
		info, err := os.Lstat(dir)
		if err != nil {
			return "", fmt.Errorf("prepare checkout: %w", err)
		}

		if !info.IsDir() {
			return "", fmt.Errorf("prepare checkout: %s is not a directory", dir)
		}

		// MkdirAll's mode passes through the umask, and an existing directory keeps
		// the mode it had. Neither answers "is this private".
		if err := os.Chmod(dir, privateDirMode); err != nil {
			return "", fmt.Errorf("prepare checkout: %w", err)
		}
	}

	return deployment, nil
}

// replace empties the checkout path and returns it ready to be a working tree.
// This is the one destructive step, so anything there that is not an ordinary
// directory — a symlink, a file, a device — is refused and left alone rather
// than removed.
func replace(dir string) error {
	info, err := os.Lstat(dir)

	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return fmt.Errorf("prepare checkout: %w", err)
	case !info.IsDir():
		return fmt.Errorf("prepare checkout: %s exists and is not a directory; it was left as it is", dir)
	default:
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("prepare checkout: remove the previous checkout: %w", err)
		}
	}

	if err := os.Mkdir(dir, publicDirMode); err != nil {
		return fmt.Errorf("prepare checkout: %w", err)
	}

	return os.Chmod(dir, publicDirMode)
}

// fixModes gives the checkout the modes the sandbox user needs, after git wrote
// it under whatever umask the daemon runs with. It does not follow symlinks:
// WalkDir does not descend into them, and a link's own entry is skipped rather
// than chmodded, because chmod resolves the link — a repository shipping
// `link -> /etc/shadow` must not make this the thing that changes its mode.
// Whether such a target is usable at all is internal/compose/paths.go's
// question.
func fixModes(root string) error {
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		switch {
		case entry.Type()&fs.ModeSymlink != 0:
			return nil
		case entry.IsDir():
			return os.Chmod(path, publicDirMode)
		case entry.Type().IsRegular():
			info, err := entry.Info()
			if err != nil {
				return err
			}

			// Executable intent is preserved rather than assigned: git records one
			// bit per file.
			mode := fileMode
			if info.Mode().Perm()&0o111 != 0 {
				mode = execFileMode
			}

			return os.Chmod(path, mode)
		default:
			// A socket, a fifo, a device: git checks none of them out, so the mode is
			// not this package's to widen.
			return nil
		}
	})
	if err != nil {
		return fmt.Errorf("prepare checkout: set checkout permissions: %w", err)
	}

	return nil
}

// request is a validated Request. The unexported fields keep the raw ones out of
// reach past validate.
type request struct {
	deploymentID string
	repoURL      string
	commit       string
}

// gitHost is the only host a Cockpit source lives on (ADR-0010). An installation
// token is GitHub's, so any other host is somewhere a credential would be sent
// to be collected.
const gitHost = "github.com"

const (
	maxDeploymentID = 64
	// GitHub's own limits on a login and a repository name.
	maxOwner    = 39
	maxRepoName = 100
)

func validate(req Request) (request, error) {
	if err := validSegment(req.DeploymentID); err != nil {
		return request{}, fmt.Errorf("prepare checkout: deployment id: %w", err)
	}

	repoURL, err := validRepoURL(req.RepoURL)
	if err != nil {
		return request{}, fmt.Errorf("prepare checkout: repository url: %w", err)
	}

	commit := strings.ToLower(req.Commit)
	if !isCommitSHA(commit) {
		return request{}, fmt.Errorf(
			"prepare checkout: commit: %q is not a full commit id; a branch, a tag, or an abbreviation is not a deployment",
			req.Commit)
	}

	return request{deploymentID: req.DeploymentID, repoURL: repoURL, commit: commit}, nil
}

// validSegment accepts one path segment: a leading letter or digit, then
// letters, digits, hyphen and underscore. That alphabet excludes `.`, `..`,
// separators, NUL, spaces, and a leading `-`.
func validSegment(segment string) error {
	switch {
	case segment == "":
		return errors.New("empty")
	case len(segment) > maxDeploymentID:
		return fmt.Errorf("longer than %d characters", maxDeploymentID)
	case !madeOf(segment, "-_"), segment[0] == '-', segment[0] == '_':
		return fmt.Errorf("%q is not a path segment of letters, digits, - and _", segment)
	}

	return nil
}

// validName is GitHub's alphabet for a login or a repository name. Dot belongs
// to it because repository names use it, which is why `.` and `..` — both path
// traversal — are excluded by name.
func validName(name string, max int) error {
	switch {
	case name == "", name == ".", name == "..":
		return fmt.Errorf("%q is not a name", name)
	case len(name) > max:
		return fmt.Errorf("longer than %d characters", max)
	case !madeOf(name, "-_."):
		return fmt.Errorf("%q is not a github name", name)
	}

	return nil
}

// madeOf reports whether s is ASCII letters, digits, and the extra bytes.
// Byte-wise, so anything multi-byte is refused rather than folded.
func madeOf(s, extra string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]

		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.IndexByte(extra, c) >= 0:
		default:
			return false
		}
	}

	return true
}

// validRepoURL accepts the canonical GitHub clone URL and returns it unchanged.
// It is not normalized into shape: a URL that is not already canonical is a
// disagreement with the Plane about which repository this is. Userinfo is
// refused by name rather than dropped, because it is the one place a credential
// can be smuggled into an argv this package promises has none.
func validRepoURL(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("empty")
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%q cannot be parsed", raw)
	}

	switch {
	case parsed.Scheme != "https":
		return "", fmt.Errorf("%q is not https", raw)
	case parsed.User != nil:
		return "", errors.New("the url carries userinfo")
	case parsed.Host != gitHost:
		return "", fmt.Errorf("%q is not on %s", raw, gitHost)
	}

	owner, repo, err := ownerAndRepo(parsed.Path)
	if err != nil {
		return "", err
	}

	// Rebuilt from the checked parts and compared to what was sent, so anything
	// the checks above did not name — a query, a fragment, a doubled slash, an
	// escape that decodes to one of these characters — is a difference rather
	// than a hole.
	canonical := "https://" + gitHost + "/" + owner + "/" + repo + ".git"
	if raw != canonical {
		return "", fmt.Errorf("%q is not the canonical clone url %q", raw, canonical)
	}

	return canonical, nil
}

// ownerAndRepo splits /{owner}/{repo}.git. A repository whose own name ends in
// .git is allowed, so the canonical URL of one ends .git.git; that is what
// GitHub and the Plane both accept.
func ownerAndRepo(path string) (string, string, error) {
	trimmed, ok := strings.CutSuffix(path, ".git")
	if !ok {
		return "", "", errors.New("the path does not end in .git")
	}

	owner, repo, ok := strings.Cut(strings.TrimPrefix(trimmed, "/"), "/")
	if !ok {
		return "", "", errors.New("the path is not /owner/repo.git")
	}

	if err := validName(owner, maxOwner); err != nil {
		return "", "", fmt.Errorf("owner: %w", err)
	}

	if err := validName(repo, maxRepoName); err != nil {
		return "", "", fmt.Errorf("repository: %w", err)
	}

	return owner, repo, nil
}

// isCommitSHA reports whether s is a full object id: 40 lowercase hex digits for
// a SHA-1 repository, 64 for a SHA-256 one. Nothing shorter, because an
// abbreviation is a request for git to resolve something.
func isCommitSHA(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}

	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}

	return true
}
