package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"beadsbridge/relay/internal/config"
	"beadsbridge/relay/internal/store"
)

type fakeRunner struct {
	calls [][]string
	out   map[string]string
	def   string
}

func (f *fakeRunner) Run(ctx context.Context, argv []string, stdin string, timeout time.Duration) (string, error) {
	key := strings.Join(argv[1:], " ")
	f.calls = append(f.calls, argv[1:])
	if strings.HasPrefix(key, "list --label kind:workflow") {
		return f.def, nil
	}
	if strings.HasPrefix(key, "create ") {
		if f.out[key] != "" {
			return f.out[key], nil
		}
		return "created " + strings.Fields(key)[1] + ".9", nil
	}
	if v, ok := f.out[key]; ok {
		return v, nil
	}
	return "{}", nil
}

func cliStore(t *testing.T, fr *fakeRunner, storeName string) *store.CLIStore {
	t.Helper()
	c := store.NewCLIStore(storeName)
	store.WithRunner(fr.Run)(c)
	return c
}

func runCLI(t *testing.T, args []string, fr *fakeRunner) string {
	t.Helper()
	cfg := config.Default()
	cfg.Store = "task"
	var buf bytes.Buffer
	err := run(context.Background(), args, cliStore(t, fr, "task"), cfg, &buf)
	if err != nil {
		t.Fatalf("run %v: %v", args, err)
	}
	return buf.String()
}

func TestCLIRoutesListsWorkflows(t *testing.T) {
	fr := &fakeRunner{
		def: `[{"id":"task-route-ops","title":"route workflow ops","description":"{\"slug\":\"ops\",\"ruleVersion\":\"relay-1\",\"route\":{\"slug\":\"ops\"},\"trust\":\"trusted\"}","status":"open","labels":["kind:workflow","route:ops","trust:trusted"]}]`,
	}
	out := runCLI(t, []string{"routes"}, fr)
	if !strings.Contains(out, "ops") || !strings.Contains(out, "trust=trusted") {
		t.Fatalf("routes output missing workflow info: %q", out)
	}
}

func TestCLIProcessSmoke(t *testing.T) {
	fr := &fakeRunner{
		def: `[{"id":"task-route-research","title":"route workflow research","description":"{\"slug\":\"research\",\"ruleVersion\":\"relay-1\",\"route\":{\"slug\":\"research\",\"prefixCmds\":[\"route: research\"]},\"trust\":\"trusted\"}","status":"open","labels":["kind:workflow","route:research","trust:trusted"]}]`,
		out: map[string]string{
			"show task-1 --json":              `[{"id":"task-1","title":"route: research","description":"","status":"open","parent":"","labels":[]}]`,
			"show task-route-research --json": `[{"id":"task-route-research","title":"route workflow research","description":"{}","status":"open","parent":"","labels":["kind:workflow","route:research","trust:trusted"]}]`,
			"children task-1 --json":          `[]`,
		},
	}
	out := runCLI(t, []string{"process", "task-1"}, fr)
	if !strings.Contains(out, "route=research") || !strings.Contains(out, " evidence=") {
		t.Fatalf("process output wrong: %q", out)
	}
	ranCreate := false
	for _, c := range fr.calls {
		if c[0] == "create" {
			ranCreate = true
		}
	}
	if !ranCreate {
		t.Fatal("process must create the evidence bead via the store CLI")
	}
}

func TestCLIUsageErrors(t *testing.T) {
	fr := &fakeRunner{}
	if err := run(context.Background(), []string{"process"}, cliStore(t, fr, "task"), config.Default(), &bytes.Buffer{}); err == nil {
		t.Fatal("process without id must error")
	}
	if err := run(context.Background(), []string{"nonsense"}, cliStore(t, fr, "task"), config.Default(), &bytes.Buffer{}); err == nil {
		t.Fatal("unknown subcommand must error")
	}
}
