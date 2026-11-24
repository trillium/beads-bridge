package relay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"beadsbridge/relay/internal/classify"
	"beadsbridge/relay/internal/config"
	"beadsbridge/relay/internal/store"
)

type Evidence struct {
	SchemaVersion    int               `json:"schemaVersion"`
	TaskID           string            `json:"taskId"`
	InputFingerprint string            `json:"inputFingerprint"`
	RuleVersion      string            `json:"ruleVersion"`
	Threshold        float64           `json:"threshold"`
	ClassifiedAt     string            `json:"classifiedAt"`
	Decision         classify.Decision `json:"decision"`
	Stages           []classify.Stage  `json:"stages"`
	LabelsApplied    []string          `json:"labelsApplied"`
}

type WorkflowDef struct {
	Slug        string         `json:"slug"`
	RuleVersion string         `json:"ruleVersion"`
	Route       classify.Route `json:"route"`
	Trust       string         `json:"trust"`
}

type Outcome struct {
	TaskID     string
	Done       bool
	Skipped    bool
	SkipReason string
	Decision   classify.Decision
	EvidenceID string
	WorkflowID string
}

type Relay struct {
	store      store.Store
	cfg        config.Config
	classifier *classify.Classifier
	now        func() time.Time
}

func New(s store.Store, cfg config.Config) (*Relay, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Relay{
		store:      s,
		cfg:        cfg,
		classifier: classify.NewClassifier(cfg.ConfidenceThreshold, cfg.RulesVersion),
		now:        func() time.Time { return time.Now().UTC() },
	}, nil
}

func (r *Relay) WithClock(now func() time.Time) *Relay {
	r.now = now
	return r
}

func (r *Relay) Store() store.Store    { return r.store }
func (r *Relay) Config() config.Config { return r.cfg }

func (r *Relay) Eligible(ctx context.Context, t store.Task) (bool, string) {
	if t.Status != "" && t.Status != "open" {
		return false, "status:" + t.Status
	}
	if t.Parent != "" {
		return false, "parent:" + t.Parent
	}
	if store.HasAnyLabel(t.Labels, store.LabelRoutingReady, store.LabelRoutingTriage) {
		return false, "already-labels-route"
	}
	return true, ""
}

func (r *Relay) Process(ctx context.Context, taskID string) (Outcome, error) {
	task, err := r.store.Task(ctx, taskID)
	if err != nil {
		return Outcome{}, err
	}
	return r.processTask(ctx, task)
}

func (r *Relay) Sweep(ctx context.Context) ([]Outcome, error) {
	tasks, err := r.store.ListTasks(ctx)
	if err != nil {
		return nil, err
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].ID < tasks[j].ID })
	var out []Outcome
	for _, t := range tasks {
		o, err := r.processTask(ctx, t)
		if err != nil {
			return out, err
		}
		out = append(out, o)
	}
	return out, nil
}

func (r *Relay) processTask(ctx context.Context, task store.Task) (Outcome, error) {
	ok, reason := r.Eligible(ctx, task)
	if !ok {
		return Outcome{TaskID: task.ID, Done: false, Skipped: true, SkipReason: reason}, nil
	}

	fp := fingerprint(task.ID, task.Title, task.Description, r.cfg.RulesVersion)
	evidenceID, back, err := r.existingEvidence(ctx, task.ID, fp)
	if err != nil {
		return Outcome{}, err
	}
	if back != nil {
		return Outcome{TaskID: task.ID, Done: true, Decision: back.Decision, EvidenceID: evidenceID}, nil
	}

	routes, err := r.workflowRoutes(ctx)
	if err != nil {
		return Outcome{}, err
	}

	result := r.classifier.Classify(task.Title, task.Description, routes)
	decision := result.Decision

	if decision.Kind == classify.DecisionRoute {
		_, usable, reason, err := r.authorizeRoute(ctx, decision.Route)
		if err != nil {
			return Outcome{}, err
		}
		if !usable {
			decision.Kind = classify.DecisionTriage
			decision.Route = ""
			decision.Reason = "route-not-usable:" + reason
		}
	}

	labels := r.applyLabels(ctx, task.ID, decision, evidenceID)
	if len(labels) == 0 {
		labels = nil
	}

	ev := Evidence{
		SchemaVersion:    1,
		TaskID:           task.ID,
		InputFingerprint: fp,
		RuleVersion:      r.cfg.RulesVersion,
		Threshold:        r.cfg.ConfidenceThreshold,
		ClassifiedAt:     r.now().Format(time.RFC3339),
		Decision:         decision,
		Stages:           result.Stages,
		LabelsApplied:    labels,
	}

	createdID, err := r.persistEvidence(ctx, task.ID, ev)
	if err != nil {
		return Outcome{}, err
	}

	return Outcome{
		TaskID:     task.ID,
		Done:       true,
		Decision:   decision,
		EvidenceID: createdID,
	}, nil
}

func (r *Relay) workflowRoutes(ctx context.Context) ([]classify.Route, error) {
	beads, err := r.store.BeadsByLabel(ctx, store.LabelKindWorkflow)
	if err != nil {
		return nil, err
	}
	var routes []classify.Route
	for _, b := range beads {
		var def WorkflowDef
		if err := json.Unmarshal([]byte(b.Body), &def); err != nil {
			continue
		}
		routes = append(routes, def.Route)
	}
	return routes, nil
}

func (r *Relay) authorizeRoute(ctx context.Context, slug string) (string, bool, string, error) {
	id := r.workflowID(slug)
	bead, err := r.store.GetBead(ctx, id)
	if err != nil {
		return id, false, "no-workflow", nil
	}
	trust := store.TrustStateFromLabels(bead.Labels)
	switch trust {
	case store.TrustTrusted:
		return id, true, "trusted", nil
	case store.TrustDowngraded:
		return id, false, "downgraded", nil
	default:
		if r.cfg.AllowProvisionalRoutes {
			return id, true, "provisional-allowed", nil
		}
		return id, false, "provisional", nil
	}
}

func (r *Relay) workflowID(slug string) string {
	return r.store.StoreName() + "-route-" + slug
}

func (r *Relay) applyLabels(ctx context.Context, taskID string, d classify.Decision, evidenceID string) []string {
	var labels []string
	if d.Kind == classify.DecisionRoute {
		labels = append(labels, store.LabelRoutingReady, store.RouteLabel(d.Route))
		for _, l := range labels {
			_ = r.store.AddLabel(ctx, taskID, l, r.cfg.Actor)
		}
	} else {
		labels = []string{store.LabelRoutingTriage}
		_ = r.store.AddLabel(ctx, taskID, store.LabelRoutingTriage, r.cfg.Actor)
	}
	return labels
}

func (r *Relay) persistEvidence(ctx context.Context, taskID string, ev Evidence) (string, error) {
	body, err := json.MarshalIndent(ev, "", "  ")
	if err != nil {
		return "", err
	}
	labels := []string{store.LabelKindEvidence}
	if ev.Decision.Kind == classify.DecisionRoute {
		labels = append(labels, store.RouteLabel(ev.Decision.Route))
	} else {
		labels = append(labels, store.LabelRoutingTriage)
	}
	return r.store.CreateBead(
		ctx, "", taskID, "relay-evidence",
		string(body), labels, r.cfg.Actor,
	)
}

func (r *Relay) existingEvidence(ctx context.Context, taskID string, fp string) (string, *Evidence, error) {
	beads, err := r.store.Children(ctx, taskID)
	if err != nil {
		return "", nil, err
	}
	var match string
	var best *Evidence
	for _, b := range beads {
		if !store.HasAnyLabel(b.Labels, store.LabelKindEvidence) {
			continue
		}
		var ev Evidence
		if err := json.Unmarshal([]byte(b.Body), &ev); err != nil {
			continue
		}
		if ev.InputFingerprint == fp && ev.RuleVersion == r.cfg.RulesVersion {
			copy := ev
			best = &copy
			match = b.ID
			break
		}
	}
	return match, best, nil
}

func fingerprint(id string, title string, description string, rulesVersion string) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00%s\x00%s", id, title, description, rulesVersion)
	return hex.EncodeToString(h.Sum(nil))
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
