package checkout

// What Prepare runs, what it hands the token to, where it puts the result, and
// what it will not do.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

// The argument vectors, spelled out here rather than built from the package's
// own helpers, so a flag can only change deliberately. Each is a decision: depth
// and no-tags are what makes a deployment one commit, detach is what keeps the
// tree off a branch, --git-dir stops git discovering some other repository above
// the checkout, and no-write-fetch-head keeps the fetch's URL out of the
// repository.
var wantArgs = map[string][]string{
	"init": {"-c", "init.defaultBranch=main", "init", "--quiet"},
	"fetch": {
		"--git-dir=.git", "--work-tree=.",
		"-c", "credential.helper=",
		"-c", "core.askPass=",
		"-c", "http.followRedirects=false",
		"fetch", "--quiet", "--no-tags", "--depth=1",
		"--no-recurse-submodules", "--no-write-fetch-head",
		"https://github.com/oflabs44/cockpit.git", testCommit,
	},
	"checkout":  {"--git-dir=.git", "--work-tree=.", "checkout", "--quiet", "--detach", testCommit},
	"rev-parse": {"--git-dir=.git", "--work-tree=.", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"},
}

func TestPrepareRunsGitDirectlyWithTheseArguments(t *testing.T) {
	git := &fakeGit{}

	c, result, err := prepared(t, git, goodRequest())
	if err != nil {
		t.Fatal(err)
	}

	if got := git.verbs(); !reflect.DeepEqual(got, []string{"init", "fetch", "checkout", "rev-parse"}) {
		t.Fatalf("ran %v", got)
	}

	for verb, want := range wantArgs {
		if got := git.callTo(t, verb).Args; !reflect.DeepEqual(got, want) {
			t.Errorf("git %s args =\n%v\nwant\n%v", verb, got, want)
		}
	}

	wantDir := filepath.Join(c.Root, "dep_01HZY4", "checkout")
	if result.Dir != wantDir {
		t.Errorf("dir = %q, want %q", result.Dir, wantDir)
	}

	if result.Commit != testCommit {
		t.Errorf("commit = %q, want %q", result.Commit, testCommit)
	}

	for _, call := range git.calls {
		if call.Name != "git" {
			t.Errorf("ran %q, not git", call.Name)
		}

		if call.Dir != wantDir {
			t.Errorf("ran in %q, want %q", call.Dir, wantDir)
		}
	}
}

// The token's whole lifetime is the fetch subprocess. Every other command runs
// with the plain environment, and the plain environment is the built one — the
// daemon's own is not a deployment's.
func TestOnlyTheFetchIsGivenTheToken(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "the-daemon-environment")

	git := &fakeGit{}

	if _, _, err := prepared(t, git, goodRequest()); err != nil {
		t.Fatal(err)
	}

	for _, verb := range []string{"init", "checkout", "rev-parse"} {
		if got := git.callTo(t, verb).Env; !reflect.DeepEqual(got, baseEnv()) {
			t.Errorf("git %s env =\n%s\nwant\n%s", verb, strings.Join(got, "\n"), strings.Join(baseEnv(), "\n"))
		}
	}

	// Redacted, and asserted redacted: the shape of the seam is the thing to
	// check, and the value is the thing never to hold.
	wantFetchEnv := append(baseEnv(),
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http.https://github.com/.extraheader",
		"GIT_CONFIG_VALUE_0=Authorization: Basic "+redacted,
	)

	if got := git.callTo(t, "fetch").Env; !reflect.DeepEqual(got, wantFetchEnv) {
		t.Errorf("fetch env =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(wantFetchEnv, "\n"))
	}

	for _, entry := range baseEnv() {
		if strings.Contains(entry, "the-daemon-environment") {
			t.Errorf("the daemon environment reached git")
		}
	}
}

// The places the token must never be: the command line, the value handed back,
// and anything left on disk — the tree, .git, and the commit marker beside it.
func TestTheTokenIsNotInArgvTheResultOrAnythingOnDisk(t *testing.T) {
	git := &fakeGit{onCheckout: func(dir string) error {
		// Whatever git would persist about the fetch. The URL it records is the one
		// that was passed, which carries no credential.
		return os.WriteFile(filepath.Join(dir, ".git", "config"),
			[]byte("[remote \"origin\"]\n\turl = https://github.com/oflabs44/cockpit.git\n"), 0o600)
	}}

	c, result, err := prepared(t, git, goodRequest())
	if err != nil {
		t.Fatal(err)
	}

	for _, call := range git.calls {
		assertNoToken(t, "argv", call.Args...)
		assertNoToken(t, "the working directory", call.Dir)
	}

	assertNoToken(t, "the result", result.Dir, result.Commit)

	err = filepath.WalkDir(c.Root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return err
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		assertNoToken(t, "a file under the runtime root", string(content))
		assertNoToken(t, "a path under the runtime root", path)

		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A fetch that fails says so with the URL and the commit, which are public, and
// with git's own message, which is not this package's to vouch for — so it is
// scrubbed.
func TestAFailedFetchDoesNotEchoTheToken(t *testing.T) {
	git := &fakeGit{
		failOn:   "fetch",
		failWith: "fatal: could not read Authorization: Basic " + basicCredential(testToken) + " " + string(testToken),
	}

	_, result, err := prepared(t, git, goodRequest())
	if err == nil {
		t.Fatal("a failed fetch was reported as a checkout")
	}

	assertNoToken(t, "the error", err.Error())

	if !strings.Contains(err.Error(), redacted) {
		t.Errorf("the token was not replaced by the redaction")
	}

	if result != (Result{}) {
		t.Errorf("a failed prepare returned a result")
	}

	wrapped := scrub(fmt.Errorf("fetch: %s: %w", testToken, context.Canceled), testToken)
	if !errors.Is(wrapped, context.Canceled) {
		t.Errorf("redaction discarded the original error: %v", wrapped)
	}
}

// The token type prints as the redaction, so the ordinary accident — a %v, a log
// field, a struct dump — cannot spend it.
func TestTheTokenTypeDoesNotPrintItself(t *testing.T) {
	assertNoToken(t, "a printed token", testToken.String(), testToken.GoString())
}

// The checkout is what git says it is. A repository that ended up somewhere else
// — a fetch that got a different commit, a checkout that did not take — is a
// failure, not a deployment of an unknown commit.
func TestAWrongHeadIsNotACheckout(t *testing.T) {
	const other = "0000000000000000000000000000000000000000"

	git := &fakeGit{headOverride: other}

	c, result, err := prepared(t, git, goodRequest())
	if err == nil {
		t.Fatal("a checkout at the wrong commit was accepted")
	}

	if !strings.Contains(err.Error(), other) || !strings.Contains(err.Error(), testCommit) {
		t.Errorf("the error names neither what was asked for nor what is there: %v", err)
	}

	if result != (Result{}) {
		t.Errorf("a failed prepare returned a result")
	}

	if _, err := os.Stat(markerPath(c)); !os.IsNotExist(err) {
		t.Errorf("an unverified checkout was marked complete: %v", err)
	}
}

// Re-preparing the same deployment at the same commit is the ordinary case: a
// retried deployment, a resumed workflow, a second command over one checkout. It
// verifies what is there and fetches nothing.
func TestPreparingTheSameCommitTwiceFetchesOnce(t *testing.T) {
	git := &fakeGit{onCheckout: writeTree}

	c, first, err := prepared(t, git, goodRequest())
	if err != nil {
		t.Fatal(err)
	}

	git.calls = nil

	second, err := c.Prepare(context.Background(), goodRequest(), testToken)
	if err != nil {
		t.Fatal(err)
	}

	if second != first {
		t.Errorf("second prepare = %+v, first = %+v", second, first)
	}

	if got := git.verbs(); !reflect.DeepEqual(got, []string{"rev-parse"}) {
		t.Errorf("the second prepare ran %v, want only rev-parse", got)
	}

	if _, err := os.Stat(filepath.Join(first.Dir, "src", "app.js")); err != nil {
		t.Errorf("the verified checkout was disturbed: %v", err)
	}
}

// A run interrupted between the checkout and the mode fixing leaves a tree whose
// HEAD is already the requested commit. HEAD alone would call that done; the
// marker is what says a previous run got all the way through.
func TestAMarkerThatMatchesWithADifferentHeadIsRebuilt(t *testing.T) {
	git := &fakeGit{onCheckout: writeTree}

	c, _, err := prepared(t, git, goodRequest())
	if err != nil {
		t.Fatal(err)
	}

	git.checkedOut = strings.Repeat("0", 40)
	git.calls = nil

	if _, err := c.Prepare(context.Background(), goodRequest(), testToken); err != nil {
		t.Fatal(err)
	}

	want := []string{"rev-parse", "init", "fetch", "checkout", "rev-parse"}
	if got := git.verbs(); !reflect.DeepEqual(got, want) {
		t.Errorf("the second prepare ran %v, want %v", got, want)
	}
}

func TestAHeadThatMatchesWithoutTheMarkerIsRebuilt(t *testing.T) {
	git := &fakeGit{onCheckout: writeTree}

	c, first, err := prepared(t, git, goodRequest())
	if err != nil {
		t.Fatal(err)
	}

	if err := os.Remove(markerPath(c)); err != nil {
		t.Fatal(err)
	}

	git.calls = nil

	if _, err := c.Prepare(context.Background(), goodRequest(), testToken); err != nil {
		t.Fatal(err)
	}

	if got := git.verbs(); !reflect.DeepEqual(got, []string{"init", "fetch", "checkout", "rev-parse"}) {
		t.Errorf("the second prepare ran %v, want a full rebuild", got)
	}

	if _, err := os.Stat(filepath.Join(first.Dir, "src", "app.js")); err != nil {
		t.Errorf("the rebuilt checkout is not there: %v", err)
	}
}

// The marker lives beside the checkout, not inside it, so replacing the tree
// cannot leave a stale claim behind — and so it is not something the deployment
// builds.
func TestTheMarkerIsOutsideTheCheckoutAndClearedBeforeARebuild(t *testing.T) {
	git := &fakeGit{onCheckout: writeTree}

	c, result, err := prepared(t, git, goodRequest())
	if err != nil {
		t.Fatal(err)
	}

	marker := markerPath(c)
	if strings.HasPrefix(marker, result.Dir+string(os.PathSeparator)) {
		t.Fatalf("the marker %q is inside the checkout", marker)
	}

	recorded, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}

	if strings.TrimSpace(string(recorded)) != testCommit {
		t.Errorf("the marker records %q, want %q", recorded, testCommit)
	}

	// A rebuild that fails must not leave the previous commit's claim standing.
	git.failOn = "fetch"

	other := goodRequest()
	other.Commit = strings.Repeat("ab", 20)

	if _, err := c.Prepare(context.Background(), other, testToken); err == nil {
		t.Fatal("a failed fetch was reported as a checkout")
	}

	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Errorf("the marker survived a failed rebuild: %v", err)
	}
}

// What an interrupted run leaves behind: a directory that is not a repository,
// or is one at some other commit. It is replaced, and nothing of it survives
// into the tree the deployment then builds.
func TestAnInterruptedCheckoutIsReplaced(t *testing.T) {
	git := &fakeGit{onCheckout: writeTree}

	root := filepath.Join(t.TempDir(), "deployments")
	stale := filepath.Join(root, "dep_01HZY4", "checkout")

	if err := os.MkdirAll(filepath.Join(stale, "half-written"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(stale, "half-written", "leftover"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	c := &Checkout{Root: root, Bin: "git", Run: git.run}

	result, err := c.Prepare(context.Background(), goodRequest(), testToken)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(result.Dir, "half-written")); !os.IsNotExist(err) {
		t.Errorf("the interrupted checkout survived: %v", err)
	}

	if _, err := os.Stat(filepath.Join(result.Dir, "src", "app.js")); err != nil {
		t.Errorf("the replacement checkout is not there: %v", err)
	}
}

// The one destructive step refuses anything it does not recognise. A checkout
// path that is a symlink is not a checkout this package made, and removing it is
// a decision about somewhere else on the box.
func TestACheckoutPathThatIsNotADirectoryIsLeftAlone(t *testing.T) {
	root := filepath.Join(t.TempDir(), "deployments")
	elsewhere := filepath.Join(t.TempDir(), "elsewhere")

	if err := os.MkdirAll(filepath.Join(elsewhere, "keep"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(filepath.Join(root, "dep_01HZY4"), 0o700); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(root, "dep_01HZY4", "checkout")
	if err := os.Symlink(elsewhere, link); err != nil {
		t.Fatal(err)
	}

	git := &fakeGit{}
	c := &Checkout{Root: root, Bin: "git", Run: git.run}

	if _, err := c.Prepare(context.Background(), goodRequest(), testToken); err == nil {
		t.Fatal("a symlinked checkout path was prepared over")
	}

	if _, err := os.Stat(filepath.Join(elsewhere, "keep")); err != nil {
		t.Errorf("what the link pointed at was removed: %v", err)
	}

	if _, err := os.Lstat(link); err != nil {
		t.Errorf("the link itself was removed: %v", err)
	}
}

// A deployment directory that is a symlink is refused before anything is
// chmodded, because chmod follows the link: accepting one would set 0700 on
// whatever it names.
func TestASymlinkedDeploymentDirectoryIsRefusedBeforeChmod(t *testing.T) {
	root := filepath.Join(t.TempDir(), "deployments")
	elsewhere := filepath.Join(t.TempDir(), "elsewhere")

	if err := os.Mkdir(elsewhere, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(elsewhere, filepath.Join(root, "dep_01HZY4")); err != nil {
		t.Fatal(err)
	}

	git := &fakeGit{}
	c := &Checkout{Root: root, Bin: "git", Run: git.run}

	if _, err := c.Prepare(context.Background(), goodRequest(), testToken); err == nil {
		t.Fatal("a symlinked deployment directory was accepted")
	}

	info, err := os.Lstat(elsewhere)
	if err != nil {
		t.Fatal(err)
	}

	if got := info.Mode().Perm(); got != 0o755 {
		t.Errorf("what the link pointed at is now %o, want 755", got)
	}

	if len(git.calls) != 0 {
		t.Errorf("git ran against a symlinked deployment directory")
	}
}

// The layout in one place: a private root, a private deployment directory, and a
// world-readable tree inside it. The sandbox that normalizes the Compose model
// runs as an unmapped user and reads the checkout through a bind mount, so the
// tree has to be 0755/0644; the mount is resolved at the mountpoint, so the 0700
// above it still keeps every other user on the box out.
func TestPermissionLayout(t *testing.T) {
	// A permissive umask would hide a missing chmod, and a strict one would hide a
	// mode that was only ever requested. Set it strict: everything below has to be
	// set deliberately to come out right.
	defer syscall.Umask(syscall.Umask(0o077))

	git := &fakeGit{onCheckout: writeTree}

	c, result, err := prepared(t, git, goodRequest())
	if err != nil {
		t.Fatal(err)
	}

	assertModes(t, map[string]fs.FileMode{
		c.Root:                                     0o700,
		filepath.Join(c.Root, "dep_01HZY4"):        0o700,
		markerPath(c):                              0o600,
		result.Dir:                                 0o755,
		filepath.Join(result.Dir, ".git"):          0o755,
		filepath.Join(result.Dir, "src"):           0o755,
		filepath.Join(result.Dir, "src", "app.js"): 0o644,
		filepath.Join(result.Dir, "entrypoint.sh"): 0o755,
	})
}

// A repository controls what is in its tree, symlinks included. Fixing modes
// walks that tree, so it is a chmod driven by repository content: it must change
// the link and not what the link names, and it must not descend through one.
func TestFixingModesDoesNotFollowRepositorySymlinks(t *testing.T) {
	outside := t.TempDir()
	secretFile := filepath.Join(outside, "secret")
	secretDir := filepath.Join(outside, "dir")
	inDir := filepath.Join(secretDir, "inside")

	if err := os.WriteFile(secretFile, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.Mkdir(secretDir, 0o700); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(inDir, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}

	git := &fakeGit{onCheckout: func(dir string) error {
		if err := os.Symlink(secretFile, filepath.Join(dir, "env")); err != nil {
			return err
		}

		return os.Symlink(secretDir, filepath.Join(dir, "config"))
	}}

	_, result, err := prepared(t, git, goodRequest())
	if err != nil {
		t.Fatal(err)
	}

	assertModes(t, map[string]fs.FileMode{secretFile: 0o600, secretDir: 0o700, inDir: 0o600})

	// The link itself is still a link, still pointing where the repository pointed
	// it. Whether that target is allowed is the Compose path policy's question, and
	// it can only ask it if the link survived unchanged.
	for name, target := range map[string]string{"env": secretFile, "config": secretDir} {
		got, err := os.Readlink(filepath.Join(result.Dir, name))
		if err != nil {
			t.Fatal(err)
		}

		if got != target {
			t.Errorf("%s points at %q, want %q", name, got, target)
		}
	}
}

// An existing directory that was created too permissively — an earlier build, an
// operator's mkdir — is corrected rather than accepted.
func TestAnExistingRootIsMadePrivate(t *testing.T) {
	root := filepath.Join(t.TempDir(), "deployments")

	if err := os.MkdirAll(filepath.Join(root, "dep_01HZY4"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.Chmod(root, 0o777); err != nil {
		t.Fatal(err)
	}

	git := &fakeGit{}
	c := &Checkout{Root: root, Bin: "git", Run: git.run}

	if _, err := c.Prepare(context.Background(), goodRequest(), testToken); err != nil {
		t.Fatal(err)
	}

	assertModes(t, map[string]fs.FileMode{root: 0o700, filepath.Join(root, "dep_01HZY4"): 0o700})
}

// A relative root would compose a path from wherever the daemon happens to have
// been started, and that path is one this package removes things beneath.
func TestARelativeRootIsRefused(t *testing.T) {
	git := &fakeGit{}
	c := &Checkout{Root: "deployments", Bin: "git", Run: git.run}

	if _, err := c.Prepare(context.Background(), goodRequest(), testToken); err == nil {
		t.Fatal("a relative runtime root was accepted")
	}

	if len(git.calls) != 0 {
		t.Errorf("git ran against a relative root")
	}
}

func TestPrepareWithoutATokenOrRunnerFails(t *testing.T) {
	root := filepath.Join(t.TempDir(), "deployments")
	git := &fakeGit{}

	if _, err := (&Checkout{Root: root, Run: git.run}).Prepare(
		context.Background(), goodRequest(), "",
	); err == nil || !strings.Contains(err.Error(), "no installation token") {
		t.Fatalf("empty token error = %v", err)
	}
	if len(git.calls) != 0 {
		t.Fatal("git ran without an installation token")
	}

	if _, err := (&Checkout{Root: root}).Prepare(
		context.Background(), goodRequest(), testToken,
	); err == nil || !strings.Contains(err.Error(), "no command runner") {
		t.Fatalf("missing runner error = %v", err)
	}
}

// Every input is checked before a subprocess exists. A request that is refused
// must not have started git, because by then the token has been handed over and
// a path has been composed. One table per field, each holding only the field
// that is hostile.
func TestHostileRequestsNeverReachGit(t *testing.T) {
	deploymentIDs := map[string]string{
		"empty":           "",
		"climbs":          "..",
		"has a separator": "a/../../etc",
		"has a dot":       "dep.1",
		"has a nul":       "dep\x00",
		"has a space":     "dep 1",
		"is a flag":       "-rf",
		"is too long":     strings.Repeat("d", 65),
	}

	repoURLs := map[string]string{
		"is http":           "http://github.com/o/r.git",
		"is ssh":            "git@github.com:o/r.git",
		"is a file":         "file:///etc/passwd",
		"is ext":            "ext::sh -c whoami",
		"has userinfo":      "https://x:y@github.com/o/r.git",
		"has a query":       "https://github.com/o/r.git?a=b",
		"has a fragment":    "https://github.com/o/r.git#f",
		"is elsewhere":      "https://github.com.evil.test/o/r.git",
		"has a port":        "https://github.com:8443/o/r.git",
		"climbs":            "https://github.com/o/../../r.git",
		"has no .git":       "https://github.com/o/r",
		"is a subpath":      "https://github.com/o/r/tree/main.git",
		"escapes the slash": "https://github.com/oflabs44%2Fcockpit.git",
		"doubles the slash": "https://github.com//oflabs44/cockpit.git",
		"trails a slash":    "https://github.com/oflabs44/cockpit.git/",
		"cases the host":    "https://GitHub.com/oflabs44/cockpit.git",
		"has an empty name": "https://github.com/oflabs44/.git",
		"trails a space":    "https://github.com/oflabs44/cockpit.git ",
		"owner is too long": "https://github.com/" + strings.Repeat("o", 40) + "/cockpit.git",
		"name is too long":  "https://github.com/oflabs44/" + strings.Repeat("r", 101) + ".git",
	}

	commits := map[string]string{
		"is a branch": "main",
		"is HEAD":     "HEAD",
		"is short":    "9f1c2a3",
		"is a range":  testCommit + "^",
		"is not hex":  strings.Repeat("z", 40),
		"is empty":    "",
	}

	for name, id := range deploymentIDs {
		req := goodRequest()
		req.DeploymentID = id

		assertRefusedBeforeGit(t, "deployment id "+name, req)
	}

	for name, repoURL := range repoURLs {
		req := goodRequest()
		req.RepoURL = repoURL

		assertRefusedBeforeGit(t, "repository url "+name, req)
	}

	for name, commit := range commits {
		req := goodRequest()
		req.Commit = commit

		assertRefusedBeforeGit(t, "commit "+name, req)
	}
}

// The shapes that must keep working. The refusals live in
// TestHostileRequestsNeverReachGit, which also proves nothing ran.
func TestValidRequests(t *testing.T) {
	cases := map[string]Request{
		"an ordinary deployment": {
			DeploymentID: "dep_01HZY4ABCDEF",
			RepoURL:      "https://github.com/oflabs44/cockpit.git",
			Commit:       testCommit,
		},
		"a repository with dots and hyphens": {
			DeploymentID: "d-1",
			RepoURL:      "https://github.com/get-u.prospects/e.v-site.git",
			Commit:       testCommit,
		},
		// GitHub allows a repository named "cockpit.git", whose canonical clone URL
		// then ends .git.git. The Plane permits it, so this side must too.
		"a repository whose name ends in .git": {
			DeploymentID: "d1",
			RepoURL:      "https://github.com/oflabs44/cockpit.git.git",
			Commit:       testCommit,
		},
		"a repository name at github's limit": {
			DeploymentID: "d1",
			RepoURL:      "https://github.com/oflabs44/" + strings.Repeat("r", 100) + ".git",
			Commit:       testCommit,
		},
		"a sha-256 repository": {
			DeploymentID: "d1",
			RepoURL:      "https://github.com/oflabs44/cockpit.git",
			Commit:       strings.Repeat("ab", 32),
		},
	}

	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			valid, err := validate(req)
			if err != nil {
				t.Fatalf("%+v: %v", req, err)
			}

			// The URL is returned as it was sent, not rebuilt into shape.
			if valid.repoURL != req.RepoURL {
				t.Errorf("url = %q, want %q", valid.repoURL, req.RepoURL)
			}
		})
	}
}

// A commit is an object id, and hex is hex. The Plane may hold it either way;
// what git is asked for, and what HEAD is compared against, is one of them.
func TestCommitsAreNormalizedToLowercase(t *testing.T) {
	req := goodRequest()
	req.Commit = strings.ToUpper(testCommit)

	valid, err := validate(req)
	if err != nil {
		t.Fatal(err)
	}

	if valid.commit != testCommit {
		t.Fatalf("commit = %q, want %q", valid.commit, testCommit)
	}
}

// assertRefusedBeforeGit fails unless Prepare rejects req without running git.
func assertRefusedBeforeGit(t *testing.T, name string, req Request) {
	t.Helper()

	t.Run(name, func(t *testing.T) {
		git := &fakeGit{}
		c := &Checkout{Root: filepath.Join(t.TempDir(), "deployments"), Bin: "git", Run: git.run}

		if _, err := c.Prepare(context.Background(), req, testToken); err == nil {
			t.Fatalf("%+v was accepted", req)
		}

		if len(git.calls) != 0 {
			t.Errorf("git ran %v before the request was refused", git.verbs())
		}
	})
}

// assertModes checks each path's own permission bits, never following a symlink.
func assertModes(t *testing.T, want map[string]fs.FileMode) {
	t.Helper()

	for path, mode := range want {
		info, err := os.Lstat(path)
		if err != nil {
			t.Errorf("%s: %v", path, err)

			continue
		}

		if got := info.Mode().Perm(); got != mode {
			t.Errorf("%s is %o, want %o", path, got, mode)
		}
	}
}

// markerPath is where the completed-commit marker for the good request lives.
func markerPath(c *Checkout) string {
	return filepath.Join(c.Root, "dep_01HZY4", markerFile)
}
