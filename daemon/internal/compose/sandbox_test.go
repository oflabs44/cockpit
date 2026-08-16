package compose_test

// What normalization is actually asked to run. The sandbox is the only thing
// standing between a repository's `include` and the box's filesystem, so the
// command that starts it is asserted whole, argument for argument, rather than
// by the properties it is supposed to have.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/compose"
)

// The pinned image, spelled out here rather than read from the package, so a
// change to the digest has to be made twice and looked at once.
const sandboxImage = "docker.io/library/docker:29.7.2-cli" +
	"@sha256:000bb62ff495f986c9f5578eb67cc2cb98b91138eda81d7762d5371eb8a497fe"

// sandboxName is the container name for a checkout, derived here the way the
// package derives it: a hash of the host path, so a cancelled normalization can
// be found and removed by name.
func sandboxName(dir string) string {
	sum := sha256.Sum256([]byte(dir))

	return "cockpit-normalize-" + hex.EncodeToString(sum[:8])
}

// sandboxPrefix is the `docker run` the checkout at dir is normalized under.
func sandboxPrefix(dir string) string {
	return "docker run --rm" +
		" --name " + sandboxName(dir) +
		" --network none" +
		" --ipc none" +
		" --read-only" +
		" --cap-drop ALL" +
		" --security-opt no-new-privileges" +
		" --user 65534:65534" +
		" --memory 256m" +
		" --memory-swap 256m" +
		" --cpus 1" +
		" --pids-limit 128" +
		" --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777" +
		" --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" +
		" --env HOME=/nonexistent" +
		" --env DOCKER_CONFIG=/nonexistent/docker" +
		" --env TMPDIR=/tmp" +
		" --mount type=bind,source=" + dir + ",target=/project,readonly" +
		" --workdir /project" +
		" --entrypoint docker " + sandboxImage
}

// normalizeCall runs Normalize against a recording runner and returns the one
// command it produced, as dir plus binary plus arguments.
func normalizeCall(t *testing.T, req compose.Request) []string {
	t.Helper()

	var calls [][]string

	cli := &compose.CLI{Bin: "docker", Exec: fixedRunner(t, normalized, &calls)}

	if _, err := cli.Normalize(context.Background(), req); err != nil {
		t.Fatal(err)
	}

	if len(calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(calls))
	}

	return calls[0]
}

// The whole command, so nothing can be added, dropped, or reordered unnoticed.
// The Compose part is what it was before the sandbox — same identity, same
// file order, same flags — addressed as the sandbox sees it.
func TestNormalizeRunsComposeInTheSandbox(t *testing.T) {
	req := shopProject(t)

	want := req.Dir + " " + sandboxPrefix(req.Dir) +
		" compose --project-name cockpit-shop --project-directory /project" +
		" --file compose.yaml --file cockpit.override.yaml" +
		" config --format json --no-env-resolution --no-path-resolution"

	if got := strings.Join(normalizeCall(t, req), " "); got != want {
		t.Fatalf("call =\n%s\nwant\n%s", got, want)
	}
}

// The sandbox is only a boundary if the box's Docker daemon is out of reach.
// A socket in there would hand a repository the daemon that runs everything
// else on the box.
func TestNormalizeSandboxHasNoDockerSocket(t *testing.T) {
	for _, arg := range normalizeCall(t, shopProject(t)) {
		if strings.Contains(arg, "docker.sock") {
			t.Fatalf("the sandbox is given a docker socket: %q", arg)
		}

		if arg == "-v" || arg == "--volume" {
			t.Fatalf("the sandbox takes an unchecked volume flag: %q", arg)
		}
	}
}

// The checkout is the only thing from the box the sandbox can see. Anything
// else mounted in is another path a document's `include` could name.
func TestNormalizeSandboxMountsOnlyTheCheckout(t *testing.T) {
	req := shopProject(t)

	var mounts []string

	call := normalizeCall(t, req)
	for i, arg := range call {
		if arg == "--mount" && i+1 < len(call) {
			mounts = append(mounts, call[i+1])
		}
	}

	want := "type=bind,source=" + req.Dir + ",target=/project,readonly"
	if len(mounts) != 1 || mounts[0] != want {
		t.Fatalf("mounts = %v, want [%s]", mounts, want)
	}
}

// The tag says what this was written against; the digest is what runs. A moved
// tag must not be able to change what reads a repository's documents.
func TestNormalizeSandboxPinsTheImageByDigest(t *testing.T) {
	call := normalizeCall(t, shopProject(t))

	var image string

	for _, arg := range call {
		if strings.HasPrefix(arg, "docker.io/") {
			image = arg
		}
	}

	if image != sandboxImage {
		t.Fatalf("image = %q, want %q", image, sandboxImage)
	}
}

// The container's name is the checkout's, hashed: the same checkout normalized
// twice is the same name, so cancellation knows what to remove, and two
// checkouts are never the same container.
func TestNormalizeSandboxNamesTheContainerAfterTheCheckout(t *testing.T) {
	req := shopProject(t)
	other := shopProject(t)

	name := containerName(t, normalizeCall(t, req))

	if again := containerName(t, normalizeCall(t, req)); again != name {
		t.Fatalf("name = %q then %q, want the same checkout to keep its name", name, again)
	}

	if name != sandboxName(req.Dir) {
		t.Fatalf("name = %q, want %q", name, sandboxName(req.Dir))
	}

	if elsewhere := containerName(t, normalizeCall(t, other)); elsewhere == name {
		t.Fatalf("two checkouts share the container name %q", name)
	}
}

func containerName(t *testing.T, call []string) string {
	t.Helper()

	for i, arg := range call {
		if arg == "--name" && i+1 < len(call) {
			return call[i+1]
		}
	}

	t.Fatal("the sandbox container is unnamed")

	return ""
}

// `docker run --rm` removes the container when the container exits, not when
// the CLI that started it is killed. So a cancelled normalization removes it by
// name, and says so if it could not.
func TestNormalizeRemovesTheSandboxWhenCancelled(t *testing.T) {
	req := shopProject(t)

	cases := map[string]struct {
		remove func() error
		want   string
	}{
		"removed":     {func() error { return nil }, ""},
		"still there": {func() error { return errors.New("daemon is not responding") }, "was not removed"},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var calls [][]string

			ctx, cancel := context.WithCancel(context.Background())
			cancel()

			cli := &compose.CLI{Bin: "docker", Exec: func(
				_ context.Context, dir, bin string, args ...string,
			) ([]byte, error) {
				calls = append(calls, append([]string{dir, bin}, args...))

				if args[0] == "rm" {
					return nil, tc.remove()
				}

				return nil, errors.New("signal: killed")
			}}

			_, err := cli.Normalize(ctx, req)
			if err == nil {
				t.Fatal("want error")
			}

			if tc.want != "" && !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to say the container %s", err, tc.want)
			}

			if len(calls) != 2 {
				t.Fatalf("calls = %v, want the run and its cleanup", calls)
			}

			want := " docker rm --force " + sandboxName(req.Dir)
			if got := strings.Join(calls[1], " "); got != want {
				t.Fatalf("cleanup = %q, want %q", got, want)
			}
		})
	}
}

// A container that is already gone is what cancellation wanted, not a failure
// to report. Older Docker versions say so in words rather than exiting cleanly.
func TestNormalizeAcceptsAnAlreadyRemovedSandbox(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	cli := &compose.CLI{Bin: "docker", Exec: func(
		_ context.Context, _, _ string, args ...string,
	) ([]byte, error) {
		if args[0] == "rm" {
			return nil, errors.New("Error response from daemon: No such container: cockpit-normalize-x")
		}

		return nil, errors.New("signal: killed")
	}}

	_, err := cli.Normalize(ctx, shopProject(t))
	if err == nil || strings.Contains(err.Error(), "not removed") {
		t.Fatalf("err = %v, want the cancellation, not a cleanup failure", err)
	}
}

// The sandbox is killed rather than answering when a document needs more memory
// to parse than it is allowed. That is not a broken document, and the error
// says which limit was hit.
func TestNormalizeReportsTheParserBudget(t *testing.T) {
	killed := exitError(t, 137)

	cli := &compose.CLI{Bin: "docker", Exec: func(context.Context, string, string, ...string) ([]byte, error) {
		return nil, killed
	}}

	_, err := cli.Normalize(context.Background(), shopProject(t))
	if err == nil || !strings.Contains(err.Error(), "256m") {
		t.Fatalf("err = %v, want the parser budget named", err)
	}
}

// exitError is a real *exec.ExitError with the given status, produced by
// exiting a process with it. Nothing about the exit code is faked: it is read
// back out of a process the way it is read out of a killed container.
func exitError(t *testing.T, code int) error {
	t.Helper()

	err := exec.Command("sh", "-c", "exit "+strconv.Itoa(code)).Run()

	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != code {
		t.Fatalf("err = %v, want exit status %d", err, code)
	}

	return err
}

// The sandbox changes where Compose runs, not what the daemon asked for: the
// host checkout is not named inside the container, and the model still comes
// back parsed.
func TestNormalizeRewritesOnlyTheProjectDirectory(t *testing.T) {
	req := shopProject(t)
	call := normalizeCall(t, req)

	for i, arg := range call {
		// The recorded call is dir, binary, then arguments. The working
		// directory and the bind source are the host path's only two homes.
		if i == 0 || strings.HasPrefix(arg, "type=bind,") {
			continue
		}

		if strings.Contains(arg, req.Dir) {
			t.Fatalf("argument %d names the host checkout: %q", i, arg)
		}
	}

	cli := &compose.CLI{Bin: "docker", Exec: fixedRunner(t, normalized, nil)}

	m, err := cli.Normalize(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}

	if m.Name != "cockpit-shop" || len(m.Services) != 3 {
		t.Fatalf("model = %q with %d services", m.Name, len(m.Services))
	}
}

// dockerSandboxTest skips unless the tests that need real Docker are asked for:
// they pull the pinned image and start containers.
func dockerSandboxTest(t *testing.T) {
	t.Helper()

	if os.Getenv("COCKPIT_DOCKER_SANDBOX_TEST") != "1" {
		t.Skip("set COCKPIT_DOCKER_SANDBOX_TEST=1 to run this against real Docker")
	}
}

// sandboxCheckout is the layout the fetch slice makes: a daemon-private parent
// the box's other users cannot enter, holding a checkout the sandbox's unmapped
// user can read. The bind mount is resolved at the mountpoint, so the parent's
// mode does not reach into the container.
func sandboxCheckout(t *testing.T, files map[string]string) string {
	t.Helper()

	dir := filepath.Join(t.TempDir(), "checkout")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.Chmod(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}

	for name, content := range files {
		path := filepath.Join(dir, name)

		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}

		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	return dir
}

// The sandbox has to normalize an ordinary stack, not just refuse a hostile
// one: a repository file plus the Plane's override, with a build context, an
// env file, a named volume, and a network. It is the positive half of the
// include test below — an error there means nothing if nothing ever ran.
func TestNormalizeInTheSandboxProducesTheModel(t *testing.T) {
	dockerSandboxTest(t)

	// A variable the daemon was started with. The documents may name it; the
	// sandbox must not have it, so it interpolates to its default instead.
	t.Setenv("COCKPIT_TEST_SECRET", "daemon-secret-value")

	dir := sandboxCheckout(t, map[string]string{
		"compose.yaml": `services:
  web:
    build:
      context: ./app
      dockerfile: Dockerfile
    env_file:
      - ./.env.production
    image: registry.example/shop/web:${COCKPIT_TEST_SECRET:-unset}
    networks: [internal]
  db:
    image: postgres:17
    networks: [internal]
    volumes:
      - pgdata:/var/lib/postgresql/data
networks:
  internal:
    internal: true
volumes:
  pgdata: {}
`,
		"cockpit.override.yaml": `services:
  web:
    labels:
      cockpit.project: shop
`,
		"app/Dockerfile":  "FROM scratch\n",
		".env.production": "TOKEN=from-the-repository\n",
	})

	m, err := compose.New().Normalize(context.Background(), compose.Request{
		ProjectName: "cockpit-sandbox-test",
		Dir:         dir,
		Files:       []string{"compose.yaml", "cockpit.override.yaml"},
	})
	if err != nil {
		t.Fatal(err)
	}

	if m.Name != "cockpit-sandbox-test" {
		t.Fatalf("name = %q", m.Name)
	}

	if got := m.ServiceNames(); strings.Join(got, ",") != "db,web" {
		t.Fatalf("services = %v", got)
	}

	web := m.Services["web"]

	// The daemon's environment is not the deployment's, so the variable the
	// document names is unset in there and the default stands.
	if web.Image != "registry.example/shop/web:unset" {
		t.Fatalf("image = %q, want the daemon's environment out of reach", web.Image)
	}

	if web.Build == nil || web.Build.Context != "./app" || web.Build.Dockerfile != "Dockerfile" {
		t.Fatalf("build = %+v", web.Build)
	}

	// The env file is a reference in the model; its contents are the Project's
	// secrets and stay out of it.
	if strings.Join(web.EnvFiles, ",") != "./.env.production" {
		t.Fatalf("env_file = %v", web.EnvFiles)
	}

	if strings.Contains(string(m.Raw), "from-the-repository") {
		t.Fatal("the env file's contents are in the model")
	}

	if db := m.Services["db"]; len(db.Mounts) != 1 || db.Mounts[0].Source != "pgdata" {
		t.Fatalf("mounts = %+v", db.Mounts)
	}

	if v := m.Volumes["pgdata"]; v.Name != "cockpit-sandbox-test_pgdata" {
		t.Fatalf("volume = %+v", v)
	}

	if n := m.Networks["internal"]; !n.Internal || n.Name != "cockpit-sandbox-test_internal" {
		t.Fatalf("network = %+v", n)
	}

	// Where the sandbox put the checkout is the sandbox's business. A model
	// carrying /project would send the host verbs, and the Release snapshot,
	// to a path that exists only inside a container that is already gone.
	if strings.Contains(string(m.Raw), sandboxProjectPath) {
		t.Fatalf("the model carries the sandbox path:\n%s", m.Raw)
	}

	for _, path := range []string{
		web.Build.Context, web.Build.Dockerfile, strings.Join(web.EnvFiles, ","),
	} {
		if strings.Contains(path, sandboxProjectPath) {
			t.Fatalf("a model path is the sandbox's: %q", path)
		}
	}
}

// sandboxProjectPath is where the checkout is mounted inside the sandbox. It
// must not appear in what comes back out.
const sandboxProjectPath = "/project"

// The one test that proves the boundary rather than the command: a document
// that includes an absolute host path. It is the negative half of the test
// above — the include has to fail inside a sandbox that started and read the
// document, saying which path it could not open.
func TestNormalizeSandboxCannotReadAHostFileThroughInclude(t *testing.T) {
	dockerSandboxTest(t)

	secret := filepath.Join(t.TempDir(), "host-secret.yaml")
	if err := os.WriteFile(secret, []byte("services:\n  leak:\n    image: host-secret-leaked\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	dir := sandboxCheckout(t, map[string]string{"compose.yaml": "include:\n  - " + secret + "\n"})

	m, err := compose.New().Normalize(context.Background(), compose.Request{
		ProjectName: "cockpit-sandbox-test",
		Dir:         dir,
		Files:       []string{"compose.yaml"},
	})
	if err == nil {
		t.Fatalf("the host file was read: %+v", m)
	}

	if strings.Contains(err.Error(), "host-secret-leaked") {
		t.Fatalf("the host file was read: %v", err)
	}

	// Compose reports the path it could not open. Anything else — the image
	// missing, the mount refused, the CLI never starting — would fail this test
	// the same way a leak would, which is the point: the error has to be the
	// Compose loader's, about this include.
	if !strings.Contains(err.Error(), "open "+secret+": no such file or directory") {
		t.Fatalf("err = %v, want Compose unable to open %s inside the sandbox", err, secret)
	}
}

// Cancellation has to take the container with it. The document is a fifo
// nothing ever writes to, so Compose blocks reading it and the container is
// still running when the context is cancelled.
func TestNormalizeCancelledLeavesNoSandboxContainer(t *testing.T) {
	dockerSandboxTest(t)

	dir := sandboxCheckout(t, nil)
	if err := syscall.Mkfifo(filepath.Join(dir, "compose.yaml"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := compose.New().Normalize(ctx, compose.Request{
		ProjectName: "cockpit-sandbox-test",
		Dir:         dir,
		Files:       []string{"compose.yaml"},
	})
	if err == nil {
		t.Fatal("want the cancelled normalization to fail")
	}

	if strings.Contains(err.Error(), "was not removed") {
		t.Fatalf("err = %v", err)
	}

	out, psErr := exec.Command(
		"docker", "ps", "--all", "--quiet", "--filter", "name=^"+sandboxName(dir)+"$",
	).Output()
	if psErr != nil {
		t.Fatal(psErr)
	}

	if len(strings.TrimSpace(string(out))) != 0 {
		t.Fatalf("the sandbox container is still on the box: %s", out)
	}
}
