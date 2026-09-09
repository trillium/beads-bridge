package relay

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"beadsbridge/relay/internal/classify"
	"beadsbridge/relay/internal/config"
	"beadsbridge/relay/internal/store"
)

func testConfig() config.Config {
	c := config.Default()
	c.Store = "task"
	c.Actor = "relay-test"
	return c
}

func seedWorkflow(t *testing.T, m *store.MemoryStore, slug string, trust string) {
	t.Helper()
	def := map[string]any{
		"slug":        slug,
		"ruleVersion": "relay-1",
		"route": map[string]any{
			"slug":       slug,
			"prefixCmds": []string{"route: " + slug},
			"keywords":   map[string]float64{slug: 3},
		},
		"trust": trust,
	}
	m.SeedWorkflow(slug, trust, def)
}

func mustRelay(t *testing.T, m *store.MemoryStore, cfg config.Config) *Relay {
	t.Helper()
	r, err := New(m, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return r
}

func labelsOf(t *testing.T, m *store.MemoryStore, id string) []string {
	t.Helper()
	b, err := m.GetBead(context.Background(), id)
	if err != nil {
		t.Fatalf("GetBead %s: %v", id, err)
	}
	return b.Labels
}

func evidenceChildren(t *testing.T, m *store.MemoryStore, taskID string) []store.Bead {
	t.Helper()
	kids, err := m.Children(context.Background(), taskID)
	if err != nil {
		t.Fatalf("Children: %v", err)
	}
	var ev []store.Bead
	for _, k := range kids {
		if store.HasAnyLabel(k.Labels, store.LabelKindEvidence) {
			ev = append(ev, k)
		}
	}
	return ev
}

func TestEligibilitySkipsClosedParentalAndRoutedTasks(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-closed", "route: research", "", nil, "closed")
	m.SeedTask("t-parent", "route: research", "", nil, "open")
	if _, err := m.CreateBead(context.Background(), "", "t-parent", "child bead", "body", nil, "seed"); err != nil {
		t.Fatalf("CreateBead: %v", err)
	}
	m.SeedTask("t-routed", "route: research", "", []string{store.LabelRoutingReady}, "open")

	r := mustRelay(t, m, testConfig())
	ctx := context.Background()

	for _, id := range []string{"t-closed", "t-parent.1", "t-routed"} {
		o, err := r.Process(ctx, id)
		if err != nil {
			t.Fatalf("Process %s: %v", id, err)
		}
		if !o.Skipped {
			t.Fatalf("%s should have been skipped, got %+v", id, o)
		}
	}
	if len(evidenceChildren(t, m, "t-closed")) != 0 {
		t.Fatal("closed task must not accumulate evidence")
	}
	if len(evidenceChildren(t, m, "t-parent")) != 0 {
		t.Fatal("child bead must not be treated as a task or gain evidence")
	}
}

func TestRouteClassificationPersistsEvidenceAndLabels(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-1", "route: research", "carry out the study", nil, "open")

	r := mustRelay(t, m, testConfig())
	o, err := r.Process(context.Background(), "t-1")
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !o.Done || o.Decision.Route != "research" {
		t.Fatalf("want done research, got %+v", o)
	}

	labels := labelsOf(t, m, "t-1")
	if !store.HasAnyLabel(labels, store.LabelRoutingReady) {
		t.Fatalf("task missing routing:ready, got %v", labels)
	}
	if !store.HasAnyLabel(labels, store.RouteLabel("research")) {
		t.Fatalf("task missing route:research, got %v", labels)
	}

	ev := evidenceChildren(t, m, "t-1")
	if len(ev) != 1 {
		t.Fatalf("want exactly 1 evidence child, got %d", len(ev))
	}
	var parsed Evidence
	if err := json.Unmarshal([]byte(ev[0].Body), &parsed); err != nil {
		t.Fatalf("evidence not parseable: %v", err)
	}
	if parsed.Decision.Route != "research" || parsed.InputFingerprint == "" {
		t.Fatalf("evidence missing decision or fingerprint: %+v", parsed)
	}
}

func TestIdempotencyClassifiedTaskIsSkippedWithoutDuplicatingEvidence(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-1", "route: research", "study the literature", nil, "open")

	r := mustRelay(t, m, testConfig())
	ctx := context.Background()
	first, err := r.Process(ctx, "t-1")
	if err != nil {
		t.Fatalf("first Process: %v", err)
	}
	if !first.Done || first.EvidenceID == "" {
		t.Fatalf("first Process must produce evidence, got %+v", first)
	}

	second, err := r.Process(ctx, "t-1")
	if err != nil {
		t.Fatalf("second Process: %v", err)
	}
	if !second.Skipped {
		t.Fatalf("routed task must be skipped on reprocess, got %+v", second)
	}
	if len(evidenceChildren(t, m, "t-1")) != 1 {
		t.Fatal("reprocessing must not create a second evidence bead")
	}
}

func TestDeterminismSameInputsSameEvidence(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-1", "investigate thoroughly", "deep dive into survey data", nil, "open")
	m.SeedTask("t-2", "investigate thoroughly", "deep dive into survey data", nil, "open")

	r := mustRelay(t, m, testConfig())
	r.WithClock(func() time.Time { return time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC) })
	ctx := context.Background()
	if _, err := r.Process(ctx, "t-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Process(ctx, "t-2"); err != nil {
		t.Fatal(err)
	}

	e1 := evidenceChildren(t, m, "t-1")
	e2 := evidenceChildren(t, m, "t-2")
	if len(e1) != 1 || len(e2) != 1 {
		t.Fatalf("want 1 evidence each, got %d and %d", len(e1), len(e2))
	}
	var d1, d2 Evidence
	if err := json.Unmarshal([]byte(e1[0].Body), &d1); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(e2[0].Body), &d2); err != nil {
		t.Fatal(err)
	}
	if d1.Decision.Kind != d2.Decision.Kind || d1.Decision.Route != d2.Decision.Route || d1.Decision.Confidence != d2.Decision.Confidence {
		t.Fatalf("identical inputs must yield identical decisions: %+v vs %+v", d1.Decision, d2.Decision)
	}
	if strings.Join(d1.LabelsApplied, ",") != strings.Join(d2.LabelsApplied, ",") {
		t.Fatalf("identical inputs must yield identical labels: %v vs %v", d1.LabelsApplied, d2.LabelsApplied)
	}
}

func TestProvisionalRouteBlockedByDefault(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustProvisional)
	m.SeedTask("t-1", "route: research", "", nil, "open")

	r := mustRelay(t, m, testConfig())
	o, err := r.Process(context.Background(), "t-1")
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if o.Decision.Kind != classify.DecisionTriage {
		t.Fatalf("provisional route must not be auto-assigned, got %+v", o.Decision)
	}
	labels := labelsOf(t, m, "t-1")
	if store.HasAnyLabel(labels, store.LabelRoutingReady) || store.HasAnyLabel(labels, store.RouteLabel("research")) {
		t.Fatalf("provisional task must not carry ready/route labels, got %v", labels)
	}
	if !store.HasAnyLabel(labels, store.LabelRoutingTriage) {
		t.Fatalf("provisional task must go to triage, got %v", labels)
	}
}

func TestProvisionalAllowedWhenConfigured(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustProvisional)
	m.SeedTask("t-1", "route: research", "", nil, "open")

	cfg := testConfig()
	cfg.AllowProvisionalRoutes = true
	r := mustRelay(t, m, cfg)
	o, err := r.Process(context.Background(), "t-1")
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if o.Decision.Kind != classify.DecisionRoute || o.Decision.Route != "research" {
		t.Fatalf("provisional route should be allowed when configured, got %+v", o.Decision)
	}
}

func TestTriageFallbackStillPersistsEvidence(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustProvisional)
	m.SeedTask("t-1", "mumble mumble nothing here", "no keywords at all", nil, "open")

	r := mustRelay(t, m, testConfig())
	o, err := r.Process(context.Background(), "t-1")
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if o.Decision.Kind != classify.DecisionTriage {
		t.Fatalf("want triage, got %+v", o.Decision)
	}
	if len(evidenceChildren(t, m, "t-1")) != 1 {
		t.Fatal("triage decisions must still persist evidence")
	}
	labels := labelsOf(t, m, "t-1")
	if !store.HasAnyLabel(labels, store.LabelRoutingTriage) {
		t.Fatalf("triage task missing routing:triage, got %v", labels)
	}
}

func TestAuditAgreeLeavesTaskUnchanged(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-1", "route: research", "", nil, "open")

	r := mustRelay(t, m, testConfig())
	ctx := context.Background()
	if _, err := r.Process(ctx, "t-1"); err != nil {
		t.Fatal(err)
	}
	res, err := r.Audit(ctx, "t-1", "supervisor", "route:research", "looks right")
	if err != nil {
		t.Fatalf("Audit: %v", err)
	}
	if !res.Agree || res.Downgraded {
		t.Fatalf("agreeing audit must not downgrade, got %+v", res)
	}
	labels := labelsOf(t, m, "t-1")
	if !store.HasAnyLabel(labels, store.LabelRoutingReady) {
		t.Fatalf("agreeing audit must preserve routing:ready, got %v", labels)
	}
	if store.HasAnyLabel(labels, store.LabelRoutingTriage, store.LabelAuditDisagreed) {
		t.Fatalf("agreeing audit must not add triage/disagreed, got %v", labels)
	}
}

func TestAuditDisagreeDowngradesToTriagePreservingEvidence(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-1", "route: research", "", nil, "open")

	r := mustRelay(t, m, testConfig())
	ctx := context.Background()
	before := evidenceChildren(t, m, "t-1")
	if _, err := r.Process(ctx, "t-1"); err != nil {
		t.Fatal(err)
	}
	after := evidenceChildren(t, m, "t-1")
	if len(after) != len(before)+1 {
		t.Fatalf("processing must create evidence: %d -> %d", len(before), len(after))
	}

	res, err := r.Audit(ctx, "t-1", "supervisor", "ops", "nope, this is ops work")
	if err != nil {
		t.Fatalf("Audit: %v", err)
	}
	if res.Agree || !res.Downgraded {
		t.Fatalf("want disagree+downgrade, got %+v", res)
	}

	labels := labelsOf(t, m, "t-1")
	if store.HasAnyLabel(labels, store.LabelRoutingReady, store.RouteLabel("research")) {
		t.Fatalf("downgraded task must lose ready/route labels, got %v", labels)
	}
	if !store.HasAnyLabel(labels, store.LabelRoutingTriage, store.LabelAuditDisagreed) {
		t.Fatalf("downgraded task must carry triage+disagreed, got %v", labels)
	}
	if len(evidenceChildren(t, m, "t-1")) != len(after) {
		t.Fatal("both sides' evidence must be preserved after downgrade")
	}
}

func TestAuditDisagreeClassScopeSuspendsWorkflow(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-1", "route: research", "", nil, "open")

	cfg := testConfig()
	cfg.SuspensionScope = "class"
	r := mustRelay(t, m, cfg)
	ctx := context.Background()
	if _, err := r.Process(ctx, "t-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Audit(ctx, "t-1", "supervisor", "ops", "class-level failure"); err != nil {
		t.Fatal(err)
	}

	wf, err := m.GetBead(ctx, m.StoreName()+"-route-research")
	if err != nil {
		t.Fatalf("GetBead workflow: %v", err)
	}
	if !store.HasAnyLabel(wf.Labels, store.TrustDowngraded) {
		t.Fatalf("workflow must be downgraded under class-scope suspension, got %v", wf.Labels)
	}
}

func TestAuditDisagreeTaskScopeDoesNotTouchWorkflow(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-1", "route: research", "", nil, "open")

	r := mustRelay(t, m, testConfig())
	ctx := context.Background()
	before, err := m.GetBead(ctx, m.StoreName()+"-route-research")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Process(ctx, "t-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Audit(ctx, "t-1", "supervisor", "ops", "task-level disagreement"); err != nil {
		t.Fatal(err)
	}
	after, err := m.GetBead(ctx, m.StoreName()+"-route-research")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(before.Labels, ",") != strings.Join(after.Labels, ",") {
		t.Fatalf("task-scope suspension must not mutate workflow: %v -> %v", before.Labels, after.Labels)
	}
}

func TestNoExecutionMethodsInCallLog(t *testing.T) {
	m := store.NewMemoryStore("task")
	seedWorkflow(t, m, "research", store.TrustTrusted)
	m.SeedTask("t-1", "route: research", "", nil, "open")

	r := mustRelay(t, m, testConfig())
	ctx := context.Background()
	if _, err := r.Process(ctx, "t-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Audit(ctx, "t-1", "supervisor", "route:research", "ok"); err != nil {
		t.Fatal(err)
	}
	for _, method := range m.MethodsCalled() {
		lower := strings.ToLower(method)
		for _, forbidden := range []string{"claim", "launch", "execute", "dispatch", "run"} {
			if strings.Contains(lower, forbidden) {
				t.Fatalf("relay must never execute work: found %q in call log", method)
			}
		}
	}
	if !m.CallLogAllows("ListTasks", "Task", "GetBead", "Children", "BeadsByLabel",
		"AddLabel", "RemoveLabel", "Comment", "CreateBead") {
		t.Fatalf("call log contains unexpected methods: %v", m.MethodsCalled())
	}
}
