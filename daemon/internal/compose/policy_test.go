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

var serverPolicy = compose.Policy{ExternalNetworks: []string{"cockpit-ingress"}}

// checkout is an empty project directory on disk. The path rules are measured
// against a real directory, so the tests need one even when the documents
// under test name files that were never shipped.
func checkout(t *testing.T) compose.Request {
	t.Helper()

	return compose.Request{ProjectName: "p", Dir: t.TempDir(), Files: []string{"compose.yaml"}}
}

// validate normalizes a document through a fake runner and validates it, which
// is the order deployment uses.
func validate(t *testing.T, p compose.Policy, document string) []compose.Violation {
	t.Helper()

	return validateIn(t, checkout(t), p, document)
}

func validateIn(t *testing.T, req compose.Request, p compose.Policy, document string) []compose.Violation {
	t.Helper()

	err := p.Validate(req, normalize(t, document))
	if err == nil {
		return nil
	}

	var policyErr *compose.PolicyError
	if !errors.As(err, &policyErr) {
		t.Fatalf("err = %v, want *compose.PolicyError", err)
	}

	return policyErr.Violations
}

// One case, one rule: a document under test names exactly one refused field, so
// a failure says which rule broke rather than which list changed.
func wantOnlyViolation(t *testing.T, violations []compose.Violation, want string) {
	t.Helper()

	if len(violations) != 1 {
		t.Fatalf("violations = %v, want exactly 1", violations)
	}

	if got := violations[0].String(); !strings.Contains(got, want) {
		t.Fatalf("violation = %q, want it to contain %q", got, want)
	}
}

func TestPolicyAllowsAnOrdinaryStack(t *testing.T) {
	if v := validate(t, serverPolicy, normalized); v != nil {
		t.Fatalf("violations = %v, want none", v)
	}
}

// One rejected field per case, so a failure names the rule that broke.
func TestPolicyRejects(t *testing.T) {
	cases := map[string]struct {
		service string
		want    string
	}{
		"privileged":       {`"privileged": true`, "services.app.privileged: true"},
		"capabilities":     {`"cap_add": ["SYS_ADMIN"]`, "services.app.cap_add: SYS_ADMIN"},
		"devices":          {`"devices": ["/dev/kvm:/dev/kvm"]`, "services.app.devices: /dev/kvm:/dev/kvm"},
		"host pid":         {`"pid": "host"`, "services.app.pid: host"},
		"host ipc":         {`"ipc": "host"`, "services.app.ipc: host"},
		"host network":     {`"network_mode": "host"`, "services.app.network_mode: host"},
		"joined network":   {`"network_mode": "container:other"`, "services.app.network_mode: container:other"},
		"container name":   {`"container_name": "shop-web"`, "services.app.container_name: shop-web"},
		"published port":   {`"ports": [{"target": 80, "published": "8080"}]`, "services.app.ports: 8080"},
		"bound host port":  {`"ports": [{"target": 80, "published": "8080", "host_ip": "127.0.0.1"}]`, "services.app.ports: 127.0.0.1:8080"},
		"bind mount":       {`"volumes": [{"type": "bind", "source": "/srv/data", "target": "/data"}]`, "services.app.volumes: /srv/data:/data"},
		"docker socket":    {`"volumes": [{"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}]`, "the whole box"},
		"tmpfs mount":      {`"volumes": [{"type": "tmpfs", "target": "/scratch"}]`, `mount type "tmpfs"`},
		"external network": {`"image": "app:1"`, "networks.outside.external: someone-elses-network"},

		// The rest of the namespace and confinement surface. Each is a way to
		// reach the host or another project that none of the rules above catch.
		"security options":    {`"security_opt": ["seccomp=unconfined"]`, "services.app.security_opt: seccomp=unconfined"},
		"host user namespace": {`"userns_mode": "host"`, "services.app.userns_mode: host"},
		"host uts namespace":  {`"uts": "host"`, "services.app.uts: host"},
		"host cgroup":         {`"cgroup": "host"`, "services.app.cgroup: host"},
		"cgroup parent":       {`"cgroup_parent": "/docker/other"`, "services.app.cgroup_parent: /docker/other"},
		"device cgroup rules": {`"device_cgroup_rules": ["c 1:3 rwm"]`, "services.app.device_cgroup_rules: c 1:3 rwm"},
		"volumes from":        {`"volumes_from": ["other-container"]`, "services.app.volumes_from: other-container"},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			networks := `"internal": {"name": "p_internal", "internal": true}`
			if name == "external network" {
				networks = `"outside": {"name": "someone-elses-network", "external": true}`
			}

			document := `{"name":"p","services":{"app":{"image":"app:1",` + tc.service + `}},"networks":{` + networks + `}}`

			wantOnlyViolation(t, validate(t, serverPolicy, document), tc.want)
		})
	}
}

// Every path in a Compose file is a file the daemon hands to Docker to read as
// its own user, so one that is absolute or climbs out of the checkout reads the
// box. The check runs on the paths the repository wrote, before build or apply.
func TestPolicyRejectsPathsOutsideTheProject(t *testing.T) {
	cases := map[string]struct {
		document string
		want     string
	}{
		"absolute build context": {
			`{"name":"p","services":{"app":{"build":{"context":"/srv/other"}}}}`,
			"services.app.build.context: /srv/other: an absolute path",
		},
		"escaping build context": {
			`{"name":"p","services":{"app":{"build":{"context":"../../root"}}}}`,
			"services.app.build.context: ../../root: the path leaves",
		},
		"remote build context": {
			`{"name":"p","services":{"app":{"build":{"context":"https://github.com/other/repo.git"}}}}`,
			"services.app.build.context: https://github.com/other/repo.git: a remote context",
		},
		"git build context": {
			`{"name":"p","services":{"app":{"build":{"context":"git@github.com:other/repo.git"}}}}`,
			"a remote context",
		},
		"absolute dockerfile": {
			`{"name":"p","services":{"app":{"build":{"context":".","dockerfile":"/etc/Dockerfile"}}}}`,
			"services.app.build.dockerfile: /etc/Dockerfile: an absolute path",
		},
		"dockerfile escaping its context": {
			`{"name":"p","services":{"app":{"build":{"context":"svc","dockerfile":"../../../Dockerfile"}}}}`,
			"services.app.build.dockerfile: ../../../Dockerfile: the path leaves",
		},
		"absolute env file": {
			`{"name":"p","services":{"app":{"image":"a:1","env_file":[{"path":"/etc/environment"}]}}}`,
			"services.app.env_file: /etc/environment: an absolute path",
		},
		"escaping env file": {
			`{"name":"p","services":{"app":{"image":"a:1","env_file":[{"path":"../../.env"}]}}}`,
			"services.app.env_file: ../../.env: the path leaves",
		},
		"escaping config file": {
			`{"name":"p","services":{"app":{"image":"a:1"}},"configs":{"c":{"file":"../../etc/passwd"}}}`,
			"configs.c.file: ../../etc/passwd: the path leaves",
		},
		"absolute secret file": {
			`{"name":"p","services":{"app":{"image":"a:1"}},"secrets":{"s":{"file":"/etc/shadow"}}}`,
			"secrets.s.file: /etc/shadow: an absolute path",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			wantOnlyViolation(t, validate(t, serverPolicy, tc.document), tc.want)
		})
	}
}

// The repository controls what is in the checkout, so a path that reads as
// repo-relative can still point at the box: a committed symlink is the whole
// escape. Text alone cannot see it; the path has to be resolved on disk.
func TestPolicyRejectsSymlinksOutOfTheCheckout(t *testing.T) {
	outside := t.TempDir()

	if err := os.WriteFile(filepath.Join(outside, "stolen.env"), []byte("SECRET=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := map[string]struct {
		link     string // a symlink to create in the checkout
		target   string // what it points at, outside the checkout
		document string
		want     string
	}{
		"env file symlinked out": {
			".env", filepath.Join(outside, "stolen.env"),
			`{"name":"p","services":{"app":{"image":"a:1","env_file":[{"path":"./.env"}]}}}`,
			"services.app.env_file: ./.env: the path resolves outside",
		},
		"secret file symlinked out": {
			"db_password", filepath.Join(outside, "stolen.env"),
			`{"name":"p","services":{"app":{"image":"a:1"}},"secrets":{"s":{"file":"db_password"}}}`,
			"secrets.s.file: db_password: the path resolves outside",
		},
		"build context symlinked out": {
			"svc", outside,
			`{"name":"p","services":{"app":{"build":{"context":"./svc"}}}}`,
			"services.app.build.context: ./svc: the path resolves outside",
		},
		"dockerfile symlinked out": {
			"Dockerfile", filepath.Join(outside, "stolen.env"),
			`{"name":"p","services":{"app":{"build":{"context":".","dockerfile":"Dockerfile"}}}}`,
			"services.app.build.dockerfile: Dockerfile: the path resolves outside",
		},
		// The file itself need not exist: a directory symlinked out of the
		// checkout is the escape, and Compose would read whatever appears in it.
		"missing file under a directory symlinked out": {
			"shared", outside,
			`{"name":"p","services":{"app":{"image":"a:1","env_file":[{"path":"shared/.env"}]}}}`,
			"services.app.env_file: shared/.env: the path resolves outside",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			req := checkout(t)

			if err := os.Symlink(tc.target, filepath.Join(req.Dir, tc.link)); err != nil {
				t.Fatal(err)
			}

			wantOnlyViolation(t, validateIn(t, req, serverPolicy, tc.document), tc.want)
		})
	}
}

// `..` after a symlinked directory climbs from where the link landed, not from
// where it was written. A path that looks contained when the dots are cancelled
// on paper is not, so they are only ever cancelled against what is on disk.
func TestPolicyRejectsDotDotThroughASymlinkedDirectory(t *testing.T) {
	outside := t.TempDir()

	if err := os.WriteFile(filepath.Join(outside, "stolen.env"), []byte("SECRET=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.Mkdir(filepath.Join(outside, "shared"), 0o700); err != nil {
		t.Fatal(err)
	}

	req := checkout(t)
	if err := os.Symlink(filepath.Join(outside, "shared"), filepath.Join(req.Dir, "config")); err != nil {
		t.Fatal(err)
	}

	// Lexically this is ./stolen.env, inside the checkout. On disk it is the
	// file next to the directory the link points at.
	const document = `{"name":"p","services":{"app":{"image":"a:1",
	  "env_file":[{"path":"config/../stolen.env"}]}}}`

	wantOnlyViolation(t, validateIn(t, req, serverPolicy, document), "the path resolves outside")
}

// A symlink is only a problem when it leaves. Repositories use them inside a
// checkout all the time, and a file the repository declares but does not ship
// is Compose's decision to make, not this package's.
func TestPolicyAllowsSymlinksAndMissingFilesInsideTheCheckout(t *testing.T) {
	req := checkout(t)

	if err := os.WriteFile(filepath.Join(req.Dir, ".env.shared"), []byte("A=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := os.Symlink(".env.shared", filepath.Join(req.Dir, ".env.production")); err != nil {
		t.Fatal(err)
	}

	const document = `{"name":"p","services":{"app":{"image":"a:1",
	  "env_file":[{"path":"./.env.production"},{"path":"./.env.local","required":false}]}}}`

	if v := validateIn(t, req, serverPolicy, document); v != nil {
		t.Fatalf("violations = %v, want none", v)
	}
}

// A project directory that is not there is not a document to fix, so it is
// reported once rather than as a violation per path.
func TestPolicyRejectsAMissingProjectDirectory(t *testing.T) {
	req := compose.Request{ProjectName: "p", Dir: "/nonexistent/cockpit-checkout", Files: []string{"compose.yaml"}}

	violations := validateIn(t, req, serverPolicy, normalized)
	if len(violations) != 1 || !strings.Contains(violations[0].String(), "project directory") {
		t.Fatalf("violations = %v, want the directory reported once", violations)
	}
}

// Ordinary repository-relative references are the normal case and must stay
// out of the operator's way.
func TestPolicyAllowsRepositoryRelativePaths(t *testing.T) {
	const document = `{"name":"p","services":{"app":{
	  "build":{"context":"./services/api","dockerfile":"docker/Dockerfile"},
	  "env_file":[{"path":"./.env.production"},{"path":"config/../.env.local"}]}},
	  "configs":{"c":{"file":"docker/nginx.conf"}},
	  "secrets":{"s":{"file":"secrets/db_password"}}}`

	if v := validate(t, serverPolicy, document); v != nil {
		t.Fatalf("violations = %v, want none", v)
	}
}

// Top-level declarations the services themselves never mention. A service
// mounting `data` looks ordinary; what `data` is declared as is the question.
func TestPolicyRejectsTopLevelVolumesConfigsAndSecrets(t *testing.T) {
	cases := map[string]struct {
		document string
		want     string
	}{
		"external volume": {
			`{"name":"p","services":{"app":{"image":"a:1"}},
			  "volumes":{"data":{"name":"other-project_data","external":true}}}`,
			"volumes.data.external: other-project_data",
		},
		// A named volume that is a host bind mount in all but spelling.
		"volume driver options": {
			`{"name":"p","services":{"app":{"image":"a:1"}},
			  "volumes":{"data":{"name":"p_data","driver":"local",
			    "driver_opts":{"type":"none","o":"bind","device":"/srv"}}}}`,
			"volumes.data.driver_opts: device,o,type",
		},
		"external config": {
			`{"name":"p","services":{"app":{"image":"a:1"}},"configs":{"c":{"name":"site","external":true}}}`,
			"configs.c.external: site",
		},
		"external secret": {
			`{"name":"p","services":{"app":{"image":"a:1"}},"secrets":{"s":{"name":"db","external":true}}}`,
			"secrets.s.external: db",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			wantOnlyViolation(t, validate(t, serverPolicy, tc.document), tc.want)
		})
	}
}

// An ordinary named volume is the supported way to keep data and must stay out
// of the operator's way.
func TestPolicyAllowsAProjectOwnedVolume(t *testing.T) {
	const document = `{"name":"p","services":{"app":{"image":"a:1",
	  "volumes":[{"type":"volume","source":"data","target":"/var/lib/app"}]}},
	  "volumes":{"data":{"name":"p_data"}}}`

	if v := validate(t, serverPolicy, document); v != nil {
		t.Fatalf("violations = %v, want none", v)
	}
}

func TestPolicyAllowsApprovedExternalNetwork(t *testing.T) {
	const document = `{"name":"p","services":{"app":{"image":"app:1","networks":{"edge":null}}},
	  "networks":{"edge":{"name":"cockpit-ingress","external":true}}}`

	if v := validate(t, serverPolicy, document); v != nil {
		t.Fatalf("violations = %v, want none", v)
	}

	// The same document on a server that has not approved that network.
	if v := validate(t, compose.Policy{}, document); len(v) != 1 {
		t.Fatalf("violations = %v, want the external network rejected", v)
	}
}

// The allow-list names the network Docker joins, not the label the document
// files it under. The key is the repository's to choose, so matching on it would
// let any repository name its way onto any network on the box.
func TestPolicyMatchesTheApprovedNetworkByNameNotByKey(t *testing.T) {
	const document = `{"name":"p","services":{"app":{"image":"app:1","networks":{"cockpit-ingress":null}}},
	  "networks":{"cockpit-ingress":{"name":"someone-elses-network","external":true}}}`

	wantOnlyViolation(t, validate(t, serverPolicy, document),
		"networks.cockpit-ingress.external: someone-elses-network")
}

func TestPolicyReportsEveryViolation(t *testing.T) {
	const document = `{"name":"p","services":{
	  "app": {"image":"app:1","privileged":true,"container_name":"app"},
	  "sidecar": {"image":"side:1","pid":"host"}}}`

	violations := validate(t, serverPolicy, document)
	if len(violations) != 3 {
		t.Fatalf("violations = %v, want 3", violations)
	}

	// Sorted by service, so a repeated deployment reports the same list.
	if violations[0].Service != "app" || violations[2].Service != "sidecar" {
		t.Fatalf("violations = %v, want app first", violations)
	}

	if violations[0].Field != "privileged" || violations[1].Field != "container_name" {
		t.Fatalf("fields = %q %q", violations[0].Field, violations[1].Field)
	}
}

func TestPolicyErrorNamesTheService(t *testing.T) {
	const document = `{"name":"p","services":{"web":{"image":"w:1","privileged":true}}}`

	err := serverPolicy.Validate(checkout(t), normalize(t, document))
	if err == nil {
		t.Fatal("want error")
	}

	if !strings.Contains(err.Error(), "services.web.privileged") {
		t.Fatalf("err = %q", err)
	}
}

// The normalizer and the policy are separate steps: normalization does not
// reject, so a caller that forgets to validate is a bug in the caller, not a
// silently permissive model.
func TestNormalizeDoesNotValidate(t *testing.T) {
	const document = `{"name":"p","services":{"web":{"image":"w:1","privileged":true}}}`

	n := &compose.CLI{Bin: "docker", Exec: fixedRunner(t, document, nil)}

	m, err := n.Normalize(context.Background(), shopProject(t))
	if err != nil {
		t.Fatal(err)
	}

	if !m.Services["web"].Privileged {
		t.Fatal("privileged not carried into the model")
	}
}
