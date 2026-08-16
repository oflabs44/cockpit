package checkout

// The git this package is tested against. It acts out just enough of git to
// drive the flow: init makes a .git, fetch does nothing, checkout writes a
// working tree, rev-parse answers with whatever was checked out.
//
// It redacts as it records. A recorder that keeps the environment it was handed
// keeps the token, and a test that fails then prints it — into a terminal, a CI
// log, a bug report.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testToken is not a credential, but it is treated as one throughout, so a real
// one used by hand behaves the same way.
const testToken InstallationToken = "ghs_notarealtokenvalue000000000000000000"

const testCommit = "9f1c2a3b4d5e6f708192a3b4c5d6e7f809a1b2c3"

type gitCall struct {
	Dir  string
	Name string
	Env  []string
	Args []string
}

type fakeGit struct {
	calls []gitCall

	// checkedOut is what checkout was last asked for, and so what rev-parse
	// answers with.
	checkedOut string
	// headOverride, when set, is what rev-parse answers instead: a repository
	// that ended up at a different commit than the one asked for.
	headOverride string
	// failOn is a subcommand that fails, with failWith as git's stderr.
	failOn   string
	failWith string
	// onCheckout writes the working tree, for the tests that care what is in
	// it. Nil means write nothing.
	onCheckout func(dir string) error
}

func (f *fakeGit) run(_ context.Context, dir, name string, env, args []string) ([]byte, error) {
	f.calls = append(f.calls, gitCall{
		Dir:  dir,
		Name: name,
		Env:  redactEnv(env),
		Args: append([]string(nil), args...),
	})

	verb := subcommand(args)

	if verb == f.failOn {
		return nil, fmt.Errorf("git %s: exit status 128: %s", verb, f.failWith)
	}

	switch verb {
	case "init":
		return nil, os.MkdirAll(filepath.Join(dir, ".git"), 0o755)

	case "fetch":
		return nil, nil

	case "checkout":
		if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
			return nil, fmt.Errorf("not a git repository")
		}

		f.checkedOut = args[len(args)-1]

		if f.onCheckout != nil {
			return nil, f.onCheckout(dir)
		}

		return nil, nil

	case "rev-parse":
		if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
			return nil, fmt.Errorf("not a git repository")
		}

		head := f.checkedOut
		if f.headOverride != "" {
			head = f.headOverride
		}

		if head == "" {
			return nil, fmt.Errorf("exit status 1")
		}

		return []byte(head + "\n"), nil
	}

	return nil, fmt.Errorf("unexpected git subcommand %q", verb)
}

// verbs is the sequence of subcommands the fake was asked to run.
func (f *fakeGit) verbs() []string {
	out := make([]string, 0, len(f.calls))
	for _, call := range f.calls {
		out = append(out, subcommand(call.Args))
	}

	return out
}

// callTo returns the one call to a subcommand.
func (f *fakeGit) callTo(t *testing.T, verb string) gitCall {
	t.Helper()

	for _, call := range f.calls {
		if subcommand(call.Args) == verb {
			return call
		}
	}

	t.Fatalf("git %s was never run; ran %v", verb, f.verbs())

	return gitCall{}
}

// subcommand finds the verb in an argument list: the first argument that is
// neither a flag nor the value of a -c.
func subcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "-c":
			i++
		case strings.HasPrefix(args[i], "-"):
		default:
			return args[i]
		}
	}

	return ""
}

// redactEnv replaces the token, in either form it can take, with the redaction.
// The shape of the entry survives — `Authorization: Basic <redacted>` is still
// recognisably an auth header — so a test can assert the credential is being
// delivered without holding it.
func redactEnv(env []string) []string {
	out := make([]string, len(env))

	for i, entry := range env {
		entry = strings.ReplaceAll(entry, string(testToken), redacted)
		out[i] = strings.ReplaceAll(entry, basicCredential(testToken), redacted)
	}

	return out
}

// assertNoToken fails without printing what it found. Every value it checks is
// suspected of holding a credential, so naming the value would be the leak.
func assertNoToken(t *testing.T, where string, values ...string) {
	t.Helper()

	for _, value := range values {
		if strings.Contains(value, string(testToken)) {
			t.Errorf("%s contains the token", where)
		}

		if strings.Contains(value, basicCredential(testToken)) {
			t.Errorf("%s contains the encoded token", where)
		}
	}
}

// prepared runs one Prepare against the fake, in a temporary root.
func prepared(t *testing.T, git *fakeGit, req Request) (*Checkout, Result, error) {
	t.Helper()

	c := &Checkout{Root: filepath.Join(t.TempDir(), "deployments"), Bin: "git", Run: git.run}
	result, err := c.Prepare(context.Background(), req, testToken)

	return c, result, err
}

// A well-formed request, for the tests that are about something else.
func goodRequest() Request {
	return Request{
		DeploymentID: "dep_01HZY4",
		RepoURL:      "https://github.com/oflabs44/cockpit.git",
		Commit:       testCommit,
	}
}

// writeTree is a checked-out repository: a directory, a plain file, an
// executable, and a symlink.
func writeTree(dir string) error {
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o700); err != nil {
		return err
	}

	if err := os.WriteFile(filepath.Join(dir, "src", "app.js"), []byte("console.log(1)\n"), 0o600); err != nil {
		return err
	}

	if err := os.WriteFile(filepath.Join(dir, "entrypoint.sh"), []byte("#!/bin/sh\n"), 0o700); err != nil {
		return err
	}

	return os.Symlink("src/app.js", filepath.Join(dir, "main.js"))
}
