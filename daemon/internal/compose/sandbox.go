package compose

// The container normalization runs in.
//
// Normalization is the one verb that opens repository-controlled documents in
// order to find out what they say. Docker follows `include` and `extends.file`
// while it produces the effective model, so a check on the model is too late
// and a check on the request cannot see paths that are only named inside a
// document. Running Compose against the host filesystem therefore lets a
// repository read the box: `include: /etc/whatever.yaml` is resolved by Docker
// as the daemon's own user, and whatever it finds becomes part of the model.
//
// So normalization does not run against the host filesystem. The host Docker
// CLI starts a container from the official Docker CLI image, with the checkout
// bind-mounted read-only at a fixed path, and runs Compose in there. An
// absolute path a document names is resolved inside that container. The image
// has its own filesystem, but the checkout is the only content mounted from the
// host. Build, migrate, and apply keep running on the host, after policy has
// judged the model.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// sandboxImage is the official Docker CLI image, which carries the Compose
// plugin. It is pinned by digest as well as by tag: the tag says which version
// this was written against, the digest is what actually runs, so a moved tag
// cannot change what normalizes a repository's documents.
const sandboxImage = "docker.io/library/docker:29.7.2-cli" +
	"@sha256:000bb62ff495f986c9f5578eb67cc2cb98b91138eda81d7762d5371eb8a497fe"

const (
	// sandboxProjectDir is where the checkout appears inside the sandbox, and
	// so what the project directory is called there. It is fixed rather than
	// mirroring the host path, so the model cannot carry a host location and a
	// document cannot name one that happens to exist.
	sandboxProjectDir = "/project"

	// sandboxStateDir is the writable path the Docker CLI needs. The root
	// filesystem is read-only and the CLI still wants somewhere for temporary
	// files, so one bounded tmpfs is mounted where TMPDIR already points — on
	// the box and in the sandbox alike, which is what keeps the two
	// environments the same string for string. Docker gives a container other
	// writable pseudo-filesystems of its own, /dev among them; this is the one
	// Cockpit asks for, and it is bounded, so a document cannot fill the box's
	// disk through it and nothing written there outlives the command.
	sandboxStateDir = "/tmp"

	// sandboxUser is nobody:nobody in this image, which is Alpine-based.
	// Nothing in normalization needs a privileged user, and the checkout is
	// mounted read-only either way.
	//
	// It is an unmapped user, so the checkout itself has to be world-readable
	// and world-traversable — 0755 directories, 0644 files, which is what a
	// checkout and a generated override already are. Its parent does not: the
	// bind mount is resolved at the mountpoint, so a daemon-private 0700
	// parent still keeps the checkout away from other users on the box.
	//
	// A checkout that is not readable that way fails as a permission error
	// from Compose. It is not repaired here: chmodding a repository's files or
	// copying them somewhere readable would make normalization write to, or
	// duplicate, the thing it exists to read at arm's length.
	sandboxUser = "65534:65534"

	// sandboxMemory is the parser's whole memory budget, swap included, so a
	// document that expands without bound is killed rather than served.
	sandboxMemory = "256m"

	// sandboxCleanupTimeout bounds the removal of a container left behind by a
	// cancelled normalization. Cleanup runs when the caller's own deadline is
	// already gone, so it carries its own, and a Docker daemon that does not
	// answer within it is a failure to report rather than a hang to inherit.
	sandboxCleanupTimeout = 30 * time.Second
)

// sandboxName is the container name for a checkout: a fixed prefix plus a hash
// of the host path. Derived rather than random so a cancelled normalization can
// be cleaned up by name, and hashed rather than spelled out so the name is a
// safe Docker identifier whatever the checkout is called.
func sandboxName(hostDir string) string {
	sum := sha256.Sum256([]byte(hostDir))

	return "cockpit-normalize-" + hex.EncodeToString(sum[:8])
}

// sandboxRun wraps one Compose argument list in the `docker run` invocation
// that executes it inside the sandbox. It is the whole security boundary, so
// it is a plain function over its constants: what it returns is exactly what
// the host Docker CLI is asked to do, and a test can read it without Docker.
//
// hostDir is the checkout on the box. It is the only host path the container
// is given, and it is given read-only. There is no Docker socket, so Compose
// inside cannot reach the box's Docker daemon, no network, so it cannot reach
// anything else, and no shared IPC namespace, so it cannot reach a process
// outside it either.
func sandboxRun(hostDir, name string, composeArgs []string) []string {
	args := []string{
		"run", "--rm",
		// Named so a container the host CLI stopped waiting for can still be
		// found and removed. See CLI.removeSandbox.
		"--name", name,
		"--network", "none",
		"--ipc", "none",
		"--read-only",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--user", sandboxUser,
		// Bound parser resources prevent a repository from turning normalization
		// into an unbounded host-memory, CPU, or process-count workload.
		"--memory", sandboxMemory,
		"--memory-swap", sandboxMemory,
		"--cpus", "1",
		"--pids-limit", "128",
		"--tmpfs", sandboxStateDir + ":rw,noexec,nosuid,nodev,size=16m,mode=1777",
	}

	// The same environment the host verbs run with, so what a document
	// interpolates during normalization is what it interpolates during apply.
	// See composeEnv.
	for _, variable := range composeEnv() {
		args = append(args, "--env", variable)
	}

	args = append(args,
		"--mount", "type=bind,source="+hostDir+",target="+sandboxProjectDir+",readonly",
		"--workdir", sandboxProjectDir,
		// The image's own entrypoint is a shell wrapper. Naming the binary
		// keeps the command the arguments below describe.
		"--entrypoint", "docker",
		sandboxImage,
	)

	return append(args, composeArgs...)
}

// removeSandbox force-removes the named container.
//
// `docker run --rm` removes the container when the container exits, not when
// the CLI that started it goes away: a cancelled context kills the host CLI and
// leaves the sandbox running, holding the checkout's bind mount and its share
// of the box. So cancellation removes it explicitly, under a deadline of its
// own, because the caller's is what just expired.
//
// A container that is already gone is the outcome this wants, not a failure:
// Docker exits cleanly for an unknown name, and older versions that say so in
// words are read the same way.
func (c *CLI) removeSandbox(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), sandboxCleanupTimeout)
	defer cancel()

	if _, err := c.Exec(ctx, "", c.bin(), "rm", "--force", name); err != nil {
		if strings.Contains(err.Error(), "No such container") {
			return nil
		}

		return err
	}

	return nil
}

// sandboxOutOfBudget reports whether the sandbox was killed rather than having
// failed on its own terms: 137 is 128 plus SIGKILL, which is what the container
// exits with when the kernel stops it for using more memory than it is allowed.
// The distinction matters to whoever reads the deployment: a document that
// needs more than the parser's budget is not a broken document.
func sandboxOutOfBudget(err error) bool {
	var exit *exec.ExitError

	return errors.As(err, &exit) && exit.ExitCode() == 137
}

// sandboxKilledError explains that exit rather than reporting it as a Compose
// failure.
func sandboxKilledError(err error) error {
	return fmt.Errorf(
		"normalize compose model: the sandbox was killed: the documents need more memory to parse than the %s budget: %w",
		sandboxMemory, err,
	)
}
