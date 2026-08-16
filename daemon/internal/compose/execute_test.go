package compose_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/compose"
)

// chunk is one delivered piece of output, flattened so a test can compare the
// stage, the stream, and the text in one string.
type chunk string

func collect(out compose.Output) chunk {
	return chunk(string(out.Stage) + " " + string(out.Stream) + " " + strings.TrimRight(string(out.Bytes), "\n"))
}

// scriptedStream is a StreamRunner that records the command it was given and
// replays whatever the script emits, so the verbs are testable without Docker.
func scriptedStream(calls *[]string, script func(emit compose.Emit) error) compose.StreamRunner {
	return func(_ context.Context, dir, name string, args []string, emit compose.Emit) error {
		if calls != nil {
			*calls = append(*calls, dir+" "+name+" "+strings.Join(args, " "))
		}

		if script == nil {
			return nil
		}

		return script(emit)
	}
}

func model(t *testing.T) *compose.Model {
	t.Helper()

	return normalize(t, normalized)
}

// Every verb has to address the same stack. A build under one project name and
// an apply under another are two stacks, and the second one silently replaces
// nothing.
func TestExecutionVerbsAddressOneStack(t *testing.T) {
	var calls []string

	req := shopProject(t)
	prefix := composePrefix(req) + " "
	cli := &compose.CLI{Bin: "docker", StreamExec: scriptedStream(&calls, nil)}

	if err := cli.Build(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}

	if err := cli.RunMigration(context.Background(), req, model(t), "migrate", nil, nil); err != nil {
		t.Fatal(err)
	}

	if err := cli.Apply(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}

	want := []string{
		prefix + "build",
		prefix + "run --rm --no-TTY migrate",
		prefix + "up --detach --no-build --remove-orphans",
	}

	if len(calls) != len(want) {
		t.Fatalf("calls = %v, want %d", calls, len(want))
	}

	for i, w := range want {
		if calls[i] != w {
			t.Fatalf("call %d =\n%s\nwant\n%s", i, calls[i], w)
		}
	}
}

// A deployment log is read live, so the stage and the stream have to travel
// with the chunk rather than be inferred afterwards.
func TestExecutionLabelsOutputByStageAndStream(t *testing.T) {
	var got []chunk

	sink := func(out compose.Output) { got = append(got, collect(out)) }

	emitBoth := func(emit compose.Emit) error {
		emit(compose.Stdout, []byte("hello\n"))
		emit(compose.Stderr, []byte("noise\n"))

		return nil
	}

	req := shopProject(t)
	cli := &compose.CLI{Bin: "docker", StreamExec: scriptedStream(nil, emitBoth)}

	if err := cli.Build(context.Background(), req, sink); err != nil {
		t.Fatal(err)
	}

	if err := cli.RunMigration(context.Background(), req, model(t), "migrate", nil, sink); err != nil {
		t.Fatal(err)
	}

	if err := cli.Apply(context.Background(), req, sink); err != nil {
		t.Fatal(err)
	}

	want := []chunk{
		"build stdout hello", "build stderr noise",
		"migrate stdout hello", "migrate stderr noise",
		"apply stdout hello", "apply stderr noise",
	}

	if len(got) != len(want) {
		t.Fatalf("chunks = %v, want %d", got, len(want))
	}

	for i, w := range want {
		if got[i] != w {
			t.Fatalf("chunk %d = %q, want %q", i, got[i], w)
		}
	}
}

// Output produced before a command failed is still the operator's, and the
// error still says what went wrong.
func TestExecutionKeepsOutputWhenTheCommandFails(t *testing.T) {
	var got []chunk

	failing := func(emit compose.Emit) error {
		emit(compose.Stdout, []byte("step 1/3\n"))
		emit(compose.Stderr, []byte("failed to solve: no such file\n"))

		return errors.New("exit status 1: failed to solve: no such file")
	}

	cli := &compose.CLI{Bin: "docker", StreamExec: scriptedStream(nil, failing)}

	err := cli.Build(context.Background(), shopProject(t), func(out compose.Output) { got = append(got, collect(out)) })
	if err == nil {
		t.Fatal("want error")
	}

	if !strings.Contains(err.Error(), "build project images") || !strings.Contains(err.Error(), "no such file") {
		t.Fatalf("err = %q, want the stage and the reason", err)
	}

	if len(got) != 2 || got[0] != "build stdout step 1/3" {
		t.Fatalf("chunks = %v, want both kept", got)
	}
}

// The Plane names the migration service; the repository decides whether it
// exists. A setting a repository change left behind must fail before Docker
// runs anything, not halfway through a deployment.
func TestRunMigrationValidatesTheService(t *testing.T) {
	cli := &compose.CLI{Bin: "docker", StreamExec: scriptedStream(nil, func(compose.Emit) error {
		t.Fatal("runner must not be reached")

		return nil
	})}

	req := shopProject(t)

	cases := map[string]string{
		"unknown service": "db-migrate",
		"no service":      "",
	}

	for name, service := range cases {
		t.Run(name, func(t *testing.T) {
			err := cli.RunMigration(context.Background(), req, model(t), service, nil, nil)
			if err == nil {
				t.Fatal("want error")
			}
		})
	}

	// The error names the services the repository does have, because the fix
	// is to pick one of them.
	err := cli.RunMigration(context.Background(), req, model(t), "db-migrate", nil, nil)
	if !strings.Contains(err.Error(), "db, migrate, web") {
		t.Fatalf("err = %q, want the available services", err)
	}
}

// A Project may override the migration command. Without one the service runs
// as the repository defined it; with one, the override is the container's
// command and everything after the service name belongs to the container.
func TestRunMigrationHonoursTheCommandOverride(t *testing.T) {
	cases := map[string]struct {
		command []string
		want    string
	}{
		"no override":      {nil, ""},
		"empty override":   {[]string{}, ""},
		"command override": {[]string{"php", "artisan", "migrate", "--force"}, " php artisan migrate --force"},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var calls []string

			req := shopProject(t)
			want := composePrefix(req) + " run --rm --no-TTY migrate" + tc.want
			cli := &compose.CLI{Bin: "docker", StreamExec: scriptedStream(&calls, nil)}

			if err := cli.RunMigration(context.Background(), req, model(t), "migrate", tc.command, nil); err != nil {
				t.Fatal(err)
			}

			if len(calls) != 1 || calls[0] != want {
				t.Fatalf("call =\n%s\nwant\n%s", strings.Join(calls, "\n"), want)
			}
		})
	}
}

func TestExecutionRejectsBadRequests(t *testing.T) {
	cli := &compose.CLI{Bin: "docker", StreamExec: scriptedStream(nil, func(compose.Emit) error {
		t.Fatal("runner must not be reached")

		return nil
	})}

	verbs := map[string]func(compose.Request) error{
		"build": func(r compose.Request) error { return cli.Build(context.Background(), r, nil) },
		"migrate": func(r compose.Request) error {
			return cli.RunMigration(context.Background(), r, model(t), "migrate", nil, nil)
		},
		"apply": func(r compose.Request) error { return cli.Apply(context.Background(), r, nil) },
	}

	for verb, run := range verbs {
		for name, req := range badRequests(t) {
			t.Run(verb+"/"+name, func(t *testing.T) {
				if err := run(req); err == nil {
					t.Fatal("want error")
				}
			})
		}
	}
}
