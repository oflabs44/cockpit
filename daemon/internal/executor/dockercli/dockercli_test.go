package dockercli_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/executor/dockercli"
)

const psOutput = `{"ID":"a1b2","Names":"web","Image":"nginx:1.27","State":"running","Status":"Up 3 hours (healthy)","Labels":"cockpit.kind=app,traefik.enable=true","CreatedAt":"2026-07-01 09:15:00 +0200 CEST"}
{"ID":"c3d4","Names":"api,api-old","Image":"api:2","State":"exited","Status":"Exited (1) 5 minutes ago","Labels":"","CreatedAt":""}
`

func discardLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestParsePS(t *testing.T) {
	cs, err := dockercli.ParsePS([]byte(psOutput), discardLog())
	if err != nil {
		t.Fatal(err)
	}

	if len(cs) != 2 {
		t.Fatalf("containers = %d, want 2", len(cs))
	}

	web := cs[0]

	if web.ID != "a1b2" || web.Name != "web" || web.Image != "nginx:1.27" {
		t.Fatalf("web = %+v", web)
	}

	if web.Health != "healthy" {
		t.Fatalf("health = %q, want healthy", web.Health)
	}

	if web.Labels["cockpit.kind"] != "app" || web.Labels["traefik.enable"] != "true" {
		t.Fatalf("labels = %+v", web.Labels)
	}

	if web.Created == 0 {
		t.Fatal("created not parsed")
	}

	api := cs[1]

	// Multiple names: the first is the container's own.
	if api.Name != "api" {
		t.Fatalf("name = %q, want api", api.Name)
	}

	if api.Health != "" || api.Labels != nil || api.Created != 0 {
		t.Fatalf("api = %+v, want no health, no labels, no created", api)
	}
}

func TestParsePSRejectsGarbage(t *testing.T) {
	if _, err := dockercli.ParsePS([]byte("not json\n"), discardLog()); err == nil {
		t.Fatal("want error")
	}
}

// The fifth field is the local image id; the sixth is the registry digest,
// empty for an image built on the box.
const inspectOutput = "a1b2\t2026-07-01T09:15:04.123456789Z\t2\talways\tsha256:localid\tnginx@sha256:regdigest\n" +
	"c3d4\t0001-01-01T00:00:00Z\t0\tno\tsha256:builtlocally\t\n"

func TestListContainersInvokesPSThenInspect(t *testing.T) {
	var calls [][]string

	c := &dockercli.Client{
		Bin: "docker",
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			calls = append(calls, append([]string{name}, args...))

			if args[0] == "inspect" {
				return []byte(inspectOutput), nil
			}

			return []byte(psOutput), nil
		},
	}

	cs, err := c.ListContainers(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(calls) != 2 {
		t.Fatalf("made %d calls, want ps then one inspect for both containers", len(calls))
	}

	if joined := strings.Join(calls[0], " "); joined != "docker ps --all --no-trunc --format {{json .}}" {
		t.Fatalf("ps invocation = %q", joined)
	}

	// One inspect covering every container, not one per container.
	if last := calls[1]; last[len(last)-2] != "a1b2" || last[len(last)-1] != "c3d4" {
		t.Fatalf("inspect invocation = %q", strings.Join(last, " "))
	}

	if cs[0].RestartCount != 2 || cs[0].RestartPolicy != "always" {
		t.Fatalf("web enrichment = %+v", cs[0])
	}

	if cs[0].ImageID != "sha256:localid" || cs[0].ImageDigest != "nginx@sha256:regdigest" {
		t.Fatalf("image id/digest = %q / %q", cs[0].ImageID, cs[0].ImageDigest)
	}

	// A locally built image has no registry digest, and reporting the local id
	// as one would be a lie the plane cannot detect.
	if cs[1].ImageID != "sha256:builtlocally" || cs[1].ImageDigest != "" {
		t.Fatalf("locally built image = %q / %q", cs[1].ImageID, cs[1].ImageDigest)
	}

	if cs[0].StartedAt == 0 {
		t.Fatal("started_at not parsed")
	}

	if cs[1].RestartPolicy != "no" || cs[1].RestartCount != 0 {
		t.Fatalf("api enrichment = %+v", cs[1])
	}
}

func TestListContainersSurvivesAFailedInspect(t *testing.T) {
	c := &dockercli.Client{
		Bin: "docker",
		Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if args[0] == "inspect" {
				return nil, errors.New("no such container")
			}

			return []byte(psOutput), nil
		},
	}

	cs, err := c.ListContainers(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// The ps facts are still true; only the enrichment is missing.
	if len(cs) != 2 || cs[0].Name != "web" || cs[0].RestartPolicy != "" {
		t.Fatalf("containers = %+v", cs)
	}
}

func TestApplyInspectSkipsMalformedLines(t *testing.T) {
	cs := []executor.Container{{ID: "a1b2"}}

	dockercli.ApplyInspect(cs, []byte("garbage\n\na1b2\t2026-07-01T09:15:04Z\tnotanumber\talways\tsha256:abc\t\n"), discardLog())

	if cs[0].RestartPolicy != "always" {
		t.Fatalf("good fields on a partly bad line were dropped: %+v", cs[0])
	}

	if cs[0].RestartCount != 0 {
		t.Fatalf("restart_count = %d, want 0 from an unparseable field", cs[0].RestartCount)
	}
}

func TestListContainersPropagatesRunError(t *testing.T) {
	boom := errors.New("no docker")
	c := &dockercli.Client{Bin: "docker", Run: func(context.Context, string, ...string) ([]byte, error) {
		return nil, boom
	}}

	if _, err := c.ListContainers(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}
