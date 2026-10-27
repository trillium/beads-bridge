package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"

	"beadsbridge/relay/internal/config"
	"beadsbridge/relay/internal/relay"
	"beadsbridge/relay/internal/store"
)

func main() {
	cfg := config.FromEnv()
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, "relay:", err)
		os.Exit(2)
	}
	s := store.NewCLIStore(cfg.Store)
	if err := run(context.Background(), os.Args[1:], s, cfg, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "relay:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, s store.Store, cfg config.Config, out io.Writer) error {
	if len(args) < 1 {
		return fmt.Errorf("missing subcommand\n%w", usageError())
	}

	r, err := relay.New(s, cfg)
	if err != nil {
		return err
	}

	switch args[0] {
	case "process":
		if len(args) < 2 {
			return usageErr("process requires <task-id>")
		}
		o, err := r.Process(ctx, args[1])
		if err != nil {
			return err
		}
		printOutcome(out, o)

	case "sweep":
		outcomes, err := r.Sweep(ctx)
		if err != nil {
			return err
		}
		for _, o := range outcomes {
			printOutcome(out, o)
		}
		fmt.Fprintf(out, "sweep: processed %d\n", len(outcomes))

	case "audit":
		if len(args) < 3 {
			return usageErr("audit requires <task-id> <auditor-choice> [note] [--as <actor>]")
		}
		auditor := cfg.Actor
		note := ""
		rest := args[3:]
		for i := 0; i < len(rest); i++ {
			switch rest[i] {
			case "--as":
				if i+1 >= len(rest) {
					return usageErr("--as requires <actor>")
				}
				auditor = rest[i+1]
				i++
			default:
				if note == "" {
					note = rest[i]
				}
			}
		}
		res, err := r.Audit(ctx, args[1], auditor, args[2], note)
		if err != nil {
			return err
		}
		printAudit(out, res)

	case "routes":
		beads, err := s.BeadsByLabel(ctx, store.LabelKindWorkflow)
		if err != nil {
			return err
		}
		sort.Slice(beads, func(i, j int) bool { return beads[i].ID < beads[j].ID })
		for _, b := range beads {
			var def relay.WorkflowDef
			if err := json.Unmarshal([]byte(b.Body), &def); err != nil {
				fmt.Fprintf(out, "%s  (unparseable workflow body)  labels=%v\n", b.ID, b.Labels)
				continue
			}
			fmt.Fprintf(out, "%s  trust=%s  rules=%v\n", def.Slug, def.Trust, def.RuleVersion)
		}

	default:
		return usageErr("unknown subcommand " + args[0])
	}
	return nil
}

func usageErr(msg string) error { return fmt.Errorf("%s\n%s", msg, usageText()) }
func usageError() error         { return fmt.Errorf("%s", usageText()) }

func printOutcome(out io.Writer, o relay.Outcome) {
	if o.Skipped {
		fmt.Fprintf(out, "%s  skip  (%s)\n", o.TaskID, o.SkipReason)
		return
	}
	if o.Decision.Kind == "route" {
		fmt.Fprintf(out, "%s  route=%s  confidence=%.3f  evidence=%s  (%s)\n",
			o.TaskID, o.Decision.Route, o.Decision.Confidence, o.EvidenceID, o.Decision.Reason)
	} else {
		fmt.Fprintf(out, "%s  triage  confidence=%.3f  evidence=%s  (%s)\n",
			o.TaskID, o.Decision.Confidence, o.EvidenceID, o.Decision.Reason)
	}
}

func printAudit(out io.Writer, a relay.AuditResult) {
	state := "AGREE"
	if a.Downgraded {
		state = "DISAGREE->TRIAGE"
	}
	fmt.Fprintf(out, "%s  audit  %s  auditor=%s  relay={%s}  auditor={%s}  (%s)\n",
		a.TaskID, state, a.Auditor, a.RelayChoice, a.AuditorChoice, a.Reason)
}

func usageText() string {
	return `usage:
  relay process <task-id>
  relay sweep
  relay audit <task-id> <auditor-choice> [note] [--as <actor>]
  relay routes

env:
  RELAY_STORE             store CLI to shell out to (default: task)
  RELAY_THRESHOLD         confidence threshold in [0,1] (default: 0.65)
  RELAY_RULES_VERSION     rules version tag embedded in evidence (default: relay-1)
  RELAY_ALLOW_PROVISIONAL allow routing to trust:provisional workflows (default: false)
  RELAY_SUSPENSION_SCOPE  task | class (default: task)
  RELAY_ACTOR             actor recorded on labels/evidence (default: relay)`
}
