package dockercli_test

import (
	"context"
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/executor/dockercli"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

func TestRunAssemblesArgv(t *testing.T) {
	var got []string

	c := &dockercli.Client{Bin: "docker", Log: discardLog(), Exec: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		got = args

		return nil, nil
	}}

	err := c.Run(context.Background(), executor.RunSpec{
		Name:    "web",
		Image:   "nginx:1.27",
		Env:     map[string]string{"B": "2", "A": "1"},
		Labels:  map[string]string{"traefik.enable": "true"},
		Ports:   []protocol.Port{{Container: 80, Host: 8080, Protocol: "tcp"}, {Container: 9000}},
		Restart: "unless-stopped",
		CPU:     "1.0",
		Memory:  "512m",
	})
	if err != nil {
		t.Fatal(err)
	}

	joined := strings.Join(got, " ")

	want := "run --detach --name web --restart unless-stopped --cpus 1.0 --memory 512m " +
		"--env A=1 --env B=2 --label traefik.enable=true --publish 8080:80/tcp --expose 9000/tcp -- nginx:1.27"

	// Env and labels are sorted, so the same spec always produces the same
	// command; an unpublished port is exposed rather than mapped to a random
	// host port; and the image comes after --, so one that looks like a flag
	// cannot become one.
	if joined != want {
		t.Fatalf("argv = %q\nwant  %q", joined, want)
	}
}

func TestVerbsAreThinCalls(t *testing.T) {
	var calls []string

	c := &dockercli.Client{Bin: "docker", Log: discardLog(), Exec: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))

		return nil, nil
	}}

	ctx := context.Background()

	if err := c.Remove(ctx, "web"); err != nil {
		t.Fatal(err)
	}

	if err := c.Start(ctx, "web"); err != nil {
		t.Fatal(err)
	}

	if err := c.Stop(ctx, "web"); err != nil {
		t.Fatal(err)
	}

	if err := c.Restart(ctx, "web"); err != nil {
		t.Fatal(err)
	}

	want := []string{"rm --force web", "start web", "stop web", "restart web"}

	if strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
}

func TestInspectReportsAbsenceWithoutError(t *testing.T) {
	c := &dockercli.Client{Bin: "docker", Log: discardLog(), Exec: func(context.Context, string, ...string) ([]byte, error) {
		return nil, nil
	}}

	container, exists, err := c.Inspect(context.Background(), "web")
	if err != nil {
		t.Fatalf("a container that does not exist is not an error: %v", err)
	}

	if exists || container.Name != "" {
		t.Fatalf("exists = %v, container = %+v", exists, container)
	}
}

func TestInspectFindsByExactName(t *testing.T) {
	c := &dockercli.Client{Bin: "docker", Log: discardLog(), Exec: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "inspect" {
			return []byte(inspectOutput), nil
		}

		return []byte(psOutput), nil
	}}

	container, exists, err := c.Inspect(context.Background(), "web")
	if err != nil || !exists {
		t.Fatalf("exists = %v, err = %v", exists, err)
	}

	if container.Name != "web" || container.Labels["cockpit.kind"] != "app" {
		t.Fatalf("container = %+v", container)
	}
}

func TestRunPutsTheImageAfterTheOperandSeparator(t *testing.T) {
	var got []string

	c := &dockercli.Client{Bin: "docker", Log: discardLog(), Exec: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		got = args

		return nil, nil
	}}

	if err := c.Run(context.Background(), executor.RunSpec{Name: "web", Image: "--privileged"}); err != nil {
		t.Fatal(err)
	}

	if joined := strings.Join(got, " "); joined != "run --detach --name web -- --privileged" {
		t.Fatalf("argv = %q, want the image parsed as an operand", joined)
	}
}

func TestInspectEscapesTheNameFilter(t *testing.T) {
	var filter string

	c := &dockercli.Client{Bin: "docker", Log: discardLog(), Exec: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		for i, a := range args {
			if a == "--filter" {
				filter = args[i+1]
			}
		}

		return nil, nil
	}}

	if _, _, err := c.Inspect(context.Background(), "web.1+x"); err != nil {
		t.Fatal(err)
	}

	// Unescaped, the metacharacters would make the container miss itself, and
	// the create that follows would hit a name conflict.
	if filter != `name=^web\.1\+x$` {
		t.Fatalf("filter = %q", filter)
	}
}
