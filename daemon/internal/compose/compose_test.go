package compose_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/compose"
)

// What `docker compose config` emits for an ordinary stack under the flags
// Normalize uses: a built ingress service, a database on a named volume, a
// one-shot migration service, a custom internal network, and the shared
// external one. Paths and env files are unresolved, so they read as the
// repository wrote them.
const normalized = `{
  "name": "cockpit-shop",
  "services": {
    "web": {
      "build": {"context": ".", "dockerfile": "docker/Dockerfile", "args": {"NODE_ENV": "production"}},
      "image": "registry.example/shop/web:rel-42",
      "command": ["node", "server.js"],
      "depends_on": {"db": {"condition": "service_healthy"}},
      "environment": {"DATABASE_URL": "postgres://db/shop", "UNSET": null},
      "env_file": [{"path": "./.env.production"}, {"path": "./.env.local", "required": false}],
      "healthcheck": {"test": ["CMD", "curl", "-f", "http://localhost:3000/healthz"]},
      "networks": {"edge": null, "internal": null},
      "ports": [{"mode": "ingress", "target": 3000, "protocol": "tcp"}],
      "restart": "unless-stopped",
      "secrets": [{"source": "db_password"}],
      "deploy": {"resources": {"limits": {"cpus": "1.5", "memory": "512M"}}}
    },
    "migrate": {
      "image": "registry.example/shop/web:rel-42",
      "command": ["npm", "run", "migrate"],
      "networks": {"internal": null},
      "profiles": ["migrate"],
      "restart": "no"
    },
    "db": {
      "image": "postgres:17",
      "command": null,
      "entrypoint": null,
      "healthcheck": {"test": ["CMD-SHELL", "pg_isready"]},
      "networks": {"internal": null},
      "volumes": [{"type": "volume", "source": "pgdata", "target": "/var/lib/postgresql/data"}]
    }
  },
  "networks": {
    "edge": {"name": "cockpit-ingress", "external": true},
    "internal": {"name": "cockpit-shop_internal", "internal": true, "driver": "bridge"}
  },
  "volumes": {
    "pgdata": {"name": "cockpit-shop_pgdata", "driver": "local"}
  },
  "configs": {
    "nginx": {"name": "cockpit-shop_nginx", "file": "docker/nginx.conf"}
  },
  "secrets": {
    "db_password": {"name": "cockpit-shop_db_password", "file": "secrets/db_password"}
  }
}`

// shopProject is the request the tests normalize and execute. Its directory is
// a real one: the request rules resolve the documents on disk before Docker is
// allowed to open them, so there has to be a disk to resolve them against.
func shopProject(t *testing.T) compose.Request {
	t.Helper()

	return compose.Request{
		ProjectName: "cockpit-shop",
		Dir:         t.TempDir(),
		Files:       []string{"compose.yaml", "cockpit.override.yaml"},
	}
}

// composePrefix is the docker argument prefix every verb shares for req.
func composePrefix(req compose.Request) string {
	return req.Dir + " docker compose --project-name " + req.ProjectName +
		" --project-directory " + req.Dir + " --file compose.yaml --file cockpit.override.yaml"
}

func fixedRunner(t *testing.T, out string, calls *[][]string) compose.Runner {
	t.Helper()

	return func(_ context.Context, dir, name string, args ...string) ([]byte, error) {
		if calls != nil {
			*calls = append(*calls, append([]string{dir, name}, args...))
		}

		return []byte(out), nil
	}
}

func normalize(t *testing.T, out string) *compose.Model {
	t.Helper()

	cli := &compose.CLI{Bin: "docker", Exec: fixedRunner(t, out, nil)}

	m, err := cli.Normalize(context.Background(), shopProject(t))
	if err != nil {
		t.Fatal(err)
	}

	return m
}

func TestNormalizeInvokesComposeConfig(t *testing.T) {
	var calls [][]string

	req := shopProject(t)
	cli := &compose.CLI{Bin: "docker", Exec: fixedRunner(t, normalized, &calls)}

	if _, err := cli.Normalize(context.Background(), req); err != nil {
		t.Fatal(err)
	}

	if len(calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(calls))
	}

	// Resolution stays off, so the model shows the repository's own paths and
	// carries no env file contents.
	want := composePrefix(req) + " config --format json --no-env-resolution --no-path-resolution"
	if got := strings.Join(calls[0], " "); got != want {
		t.Fatalf("call =\n%s\nwant\n%s", got, want)
	}
}

func TestNormalizeReportsRunnerFailure(t *testing.T) {
	cli := &compose.CLI{Bin: "docker", Exec: func(context.Context, string, string, ...string) ([]byte, error) {
		return nil, errors.New("service db refers to undefined volume pgdata")
	}}

	_, err := cli.Normalize(context.Background(), shopProject(t))
	if err == nil || !strings.Contains(err.Error(), "undefined volume") {
		t.Fatalf("err = %v, want the compose failure", err)
	}
}

func TestNormalizeRejectsBadRequests(t *testing.T) {
	cli := &compose.CLI{Bin: "docker", Exec: func(context.Context, string, string, ...string) ([]byte, error) {
		t.Fatal("runner must not be reached")

		return nil, nil
	}}

	for name, req := range badRequests(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := cli.Normalize(context.Background(), req); err == nil {
				t.Fatal("want error")
			}
		})
	}
}

// badRequests are requests no verb may run. The runner must not be reached for
// any of them: the last two would otherwise have Docker read a file the daemon
// was never given.
func badRequests(t *testing.T) map[string]compose.Request {
	t.Helper()

	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "elsewhere.yaml")

	if err := os.WriteFile(outside, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(outside, filepath.Join(dir, "linked.yaml")); err != nil {
		t.Fatal(err)
	}

	return map[string]compose.Request{
		"no project name":   {Dir: dir, Files: []string{"compose.yaml"}},
		"no directory":      {ProjectName: "p", Files: []string{"compose.yaml"}},
		"no files":          {ProjectName: "p", Dir: dir},
		"missing directory": {ProjectName: "p", Dir: filepath.Join(dir, "gone"), Files: []string{"compose.yaml"}},
		"absolute file":     {ProjectName: "p", Dir: dir, Files: []string{"/etc/compose.yaml"}},
		"escaping file":     {ProjectName: "p", Dir: dir, Files: []string{"../../etc/compose.yaml"}},
		"file symlinked out of the checkout": {
			ProjectName: "p", Dir: dir, Files: []string{"linked.yaml"},
		},
	}
}

// Normalization is what opens the documents, so a Compose file symlinked out of
// the checkout cannot wait for a model to be judged: by then Docker has read
// it. The request is refused before the CLI is invoked at all.
func TestNormalizeRejectsAComposeFileSymlinkedOutOfTheCheckout(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "elsewhere.yaml")
	if err := os.WriteFile(outside, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	req := shopProject(t)
	if err := os.Symlink(outside, filepath.Join(req.Dir, "compose.yaml")); err != nil {
		t.Fatal(err)
	}

	cli := &compose.CLI{Bin: "docker", Exec: func(context.Context, string, string, ...string) ([]byte, error) {
		t.Fatal("docker must not be asked to read the document")

		return nil, nil
	}}

	_, err := cli.Normalize(context.Background(), req)
	if err == nil || !strings.Contains(err.Error(), "compose file: compose.yaml: the path resolves outside") {
		t.Fatalf("err = %v, want the document rejected", err)
	}
}

func TestNormalizeBuildsEffectiveModel(t *testing.T) {
	m := normalize(t, normalized)

	if m.Name != "cockpit-shop" {
		t.Fatalf("name = %q", m.Name)
	}

	if got := m.ServiceNames(); strings.Join(got, ",") != "db,migrate,web" {
		t.Fatalf("services = %v", got)
	}

	web := m.Services["web"]

	if web.Image != "registry.example/shop/web:rel-42" {
		t.Fatalf("image = %q", web.Image)
	}

	if web.Build == nil || web.Build.Context != "." || web.Build.Args["NODE_ENV"] != "production" {
		t.Fatalf("build = %+v", web.Build)
	}

	if strings.Join(web.Command, " ") != "node server.js" {
		t.Fatalf("command = %v", web.Command)
	}

	if strings.Join(web.DependsOn, ",") != "db" {
		t.Fatalf("depends_on = %v", web.DependsOn)
	}

	if web.Environment["DATABASE_URL"] != "postgres://db/shop" {
		t.Fatalf("environment = %v", web.Environment)
	}

	// A null environment value means "inherit"; it must not be dropped.
	if _, ok := web.Environment["UNSET"]; !ok {
		t.Fatalf("environment = %v, want UNSET present", web.Environment)
	}

	// The env file references survive; their contents deliberately do not.
	if strings.Join(web.EnvFiles, ",") != "./.env.production,./.env.local" {
		t.Fatalf("env_file = %v", web.EnvFiles)
	}

	if web.Healthcheck == nil || web.Healthcheck.Test[0] != "CMD" {
		t.Fatalf("healthcheck = %+v", web.Healthcheck)
	}

	if strings.Join(web.Networks, ",") != "edge,internal" {
		t.Fatalf("networks = %v", web.Networks)
	}

	if web.Restart != "unless-stopped" {
		t.Fatalf("restart = %q", web.Restart)
	}

	if web.Limits == nil || web.Limits.CPUs != "1.5" || web.Limits.Memory != "512M" {
		t.Fatalf("limits = %+v", web.Limits)
	}

	// An unpublished port is a container port and stays that way.
	if len(web.Ports) != 1 || web.Ports[0].Target != 3000 || web.Ports[0].Published != "" {
		t.Fatalf("ports = %+v", web.Ports)
	}

	if got := m.Services["migrate"].Profiles; strings.Join(got, ",") != "migrate" {
		t.Fatalf("profiles = %v", got)
	}

	db := m.Services["db"]
	if len(db.Mounts) != 1 || db.Mounts[0].Type != "volume" || db.Mounts[0].Source != "pgdata" {
		t.Fatalf("mounts = %+v", db.Mounts)
	}

	// Compose emits null for a service that declares no command. That is
	// nothing, not a single empty argument.
	if db.Command != nil || db.Entrypoint != nil {
		t.Fatalf("db command = %#v, entrypoint = %#v, want neither", db.Command, db.Entrypoint)
	}

	// A custom internal network survives normalization with its resolved name.
	internal := m.Networks["internal"]
	if !internal.Internal || internal.External || internal.Name != "cockpit-shop_internal" {
		t.Fatalf("internal network = %+v", internal)
	}

	if edge := m.Networks["edge"]; !edge.External || edge.Name != "cockpit-ingress" {
		t.Fatalf("edge network = %+v", edge)
	}

	if v := m.Volumes["pgdata"]; v.Name != "cockpit-shop_pgdata" || v.External {
		t.Fatalf("volume = %+v", v)
	}

	if c := m.Configs["nginx"]; c.File != "docker/nginx.conf" || c.Name != "cockpit-shop_nginx" {
		t.Fatalf("config = %+v", c)
	}

	if s := m.Secrets["db_password"]; s.File != "secrets/db_password" {
		t.Fatalf("secret = %+v", s)
	}

	// Raw is what a Release snapshots, so it must be the document verbatim.
	if string(m.Raw) != normalized {
		t.Fatal("raw model is not the compose output")
	}
}

// Compose has emitted several shapes per field across versions. The model must
// not care which one this box's docker produced.
func TestNormalizeAcceptsAlternateComposeShapes(t *testing.T) {
	const alternate = `{
  "name": "alt",
  "services": {
    "web": {
      "image": "web:1",
      "command": "node server.js",
      "networks": ["internal"],
      "depends_on": ["db"],
      "env_file": ["./.env"],
      "ports": [{"target": 80, "published": 8080, "protocol": "tcp"}],
      "devices": [{"source": "/dev/dri", "target": "/dev/dri", "permissions": "rwm"}],
      "deploy": {"resources": {"limits": {"cpus": 2, "memory": 536870912}}}
    }
  },
  "networks": {"internal": {"external": true}}
}`

	m := normalize(t, alternate)
	web := m.Services["web"]

	if strings.Join(web.Command, " ") != "node server.js" {
		t.Fatalf("command = %v", web.Command)
	}

	if strings.Join(web.Networks, ",") != "internal" || strings.Join(web.DependsOn, ",") != "db" {
		t.Fatalf("networks = %v, depends_on = %v", web.Networks, web.DependsOn)
	}

	// env_file was a plain list of paths before Compose added `required`.
	if strings.Join(web.EnvFiles, ",") != "./.env" {
		t.Fatalf("env_file = %v", web.EnvFiles)
	}

	if web.Ports[0].Published != "8080" {
		t.Fatalf("published = %q, want 8080", web.Ports[0].Published)
	}

	if strings.Join(web.Devices, ",") != "/dev/dri:/dev/dri:rwm" {
		t.Fatalf("devices = %v", web.Devices)
	}

	if web.Limits.CPUs != "2" || web.Limits.Memory != "536870912" {
		t.Fatalf("limits = %+v", web.Limits)
	}

	if !m.Networks["internal"].External {
		t.Fatalf("external flag = %+v", m.Networks["internal"])
	}
}

func TestNormalizeRejectsGarbage(t *testing.T) {
	cli := &compose.CLI{Bin: "docker", Exec: fixedRunner(t, "not json", nil)}

	if _, err := cli.Normalize(context.Background(), shopProject(t)); err == nil {
		t.Fatal("want error")
	}
}
