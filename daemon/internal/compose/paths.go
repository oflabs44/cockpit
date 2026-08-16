package compose

// The rule about where a project's files may live, shared by the two places
// that need it: the request the daemon is about to hand to Docker, and the
// model Docker gave back.

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// leavesProject reports whether a relative path climbs out of the directory it
// is resolved against. It is lexical: it is the first of the two questions, and
// the cheap one.
func leavesProject(path string) bool {
	cleaned := filepath.Clean(path)

	return cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator))
}

// pathChecker decides whether a file a document names is inside the project.
// It holds the checkout's own real location, because that is what everything
// else is measured against.
type pathChecker struct {
	root string
}

func newPathChecker(dir string) (pathChecker, error) {
	if dir == "" {
		return pathChecker{}, fmt.Errorf("no project directory")
	}

	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return pathChecker{}, fmt.Errorf("the project directory cannot be resolved: %w", err)
	}

	return pathChecker{root: root}, nil
}

// A Compose file names files the daemon then hands to Docker to read: a build
// context, a Dockerfile, an env file, a config or a secret. Docker reads them
// as the daemon's own user, so a reference that reaches outside the checkout
// reads the box — the box's own secrets, baked into an image or handed to a
// container.
//
// Normalization keeps these paths as the repository wrote them, so the text
// checks below see what the author asked for. The text is not enough on its
// own: the repository controls the checkout's contents, and a committed
// symlink named `.env` pointing at /etc/passwd is a repo-relative path by
// every lexical measure. So the path is also resolved on disk and must land
// inside the project.
//
// value is what the document wrote; path is what to resolve, which differs
// only where a reference is relative to something other than the project root.
func (c pathChecker) check(service, field, value, path string) *Violation {
	if path == "" {
		return nil
	}

	if isRemoteContext(path) {
		return &Violation{service, field, value, "a remote context is not part of the deployed commit"}
	}

	if filepath.IsAbs(path) {
		return &Violation{service, field, value, "an absolute path reads the box, not the repository"}
	}

	if leavesProject(path) {
		return &Violation{service, field, value, "the path leaves the project directory"}
	}

	// Joined without cleaning: filepath.Join would collapse a `..` before
	// anything followed the symlink it comes after, and `config/../x` where
	// `config` points out of the checkout does not mean `x`.
	resolved, err := resolveExisting(c.root + string(filepath.Separator) + path)
	if err != nil {
		return &Violation{service, field, value, fmt.Sprintf("the path cannot be resolved: %v", err)}
	}

	if escapes(c.root, resolved) {
		return &Violation{service, field, value, "the path resolves outside the project directory"}
	}

	return nil
}

// resolveExisting follows symlinks as far as the path exists. A file the
// repository declares but does not ship is not this package's business —
// Compose decides whether it is required — but the directory it would live in
// is, because that is what a symlink out of the checkout subverts.
func resolveExisting(path string) (string, error) {
	missing := ""

	for {
		resolved, err := filepath.EvalSymlinks(path)
		if err == nil {
			// What is left does not exist, so no symlink hides in it and
			// resolving it lexically is the whole truth. Any `..` it still
			// carries climbs from here, which the containment check sees.
			return filepath.Join(resolved, missing), nil
		}

		if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}

		// Trimmed textually rather than with filepath.Dir, which cleans, and
		// cleaning is what this walk exists to avoid doing to a `..`.
		cut := strings.LastIndex(path, string(filepath.Separator))
		if cut <= 0 {
			return "", err
		}

		missing = filepath.Join(path[cut+1:], missing)
		path = path[:cut]
	}
}

// escapes reports whether a resolved path lies outside root.
func escapes(root, path string) bool {
	rel, err := filepath.Rel(root, path)

	return err != nil || leavesProject(rel)
}

// Compose accepts a URL or a Git reference as a build context. Cockpit builds
// the commit it deployed, so a context fetched from somewhere else is refused
// rather than silently built.
func isRemoteContext(path string) bool {
	if strings.Contains(path, "://") {
		return true
	}

	// scp-style Git remotes: git@host:owner/repo.git
	host, _, found := strings.Cut(path, ":")

	return found && strings.Contains(host, "@")
}
