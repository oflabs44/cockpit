package dockercli_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/executor/dockercli"
)

const psOutput = `{"ID":"a1b2","Names":"web","Image":"nginx:1.27","State":"running","Status":"Up 3 hours (healthy)","Labels":"cockpit.kind=app,traefik.enable=true","CreatedAt":"2026-07-01 09:15:00 +0200 CEST"}
{"ID":"c3d4","Names":"api,api-old","Image":"api:2","State":"exited","Status":"Exited (1) 5 minutes ago","Labels":"","CreatedAt":""}
`

func TestParsePS(t *testing.T) {
	cs, err := dockercli.ParsePS([]byte(psOutput))
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
	if _, err := dockercli.ParsePS([]byte("not json\n")); err == nil {
		t.Fatal("want error")
	}
}

func TestListContainersInvokesDockerPS(t *testing.T) {
	var gotArgs []string

	c := &dockercli.Client{
		Bin: "docker",
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			gotArgs = append([]string{name}, args...)

			return []byte(psOutput), nil
		},
	}

	cs, err := c.ListContainers(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(cs) != 2 {
		t.Fatalf("containers = %d, want 2", len(cs))
	}

	joined := strings.Join(gotArgs, " ")

	if joined != "docker ps --all --no-trunc --format {{json .}}" {
		t.Fatalf("invocation = %q", joined)
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
