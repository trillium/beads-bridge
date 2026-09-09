package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"beadsbridge/relay/internal/store"
)

type AuditResult struct {
	TaskID        string
	Auditor       string
	AuditorChoice string
	RelayChoice   string
	Agree         bool
	Downgraded    bool
	EvidenceID    string
	Reason        string
}

func (r *Relay) Audit(ctx context.Context, taskID string, auditor string, auditorChoice string, auditorNote string) (AuditResult, error) {
	evidenceID, ev, err := r.latestEvidence(ctx, taskID)
	if err != nil {
		return AuditResult{}, err
	}

	relayChoice := ev.Decision.Route
	if relayChoice == "" {
		relayChoice = "triage"
	}

	normalizedAuditor := normalizeChoice(auditorChoice)
	agree := normalizedAuditor == relayChoice

	audit := AuditResult{
		TaskID:        taskID,
		Auditor:       auditor,
		AuditorChoice: normalizedAuditor,
		RelayChoice:   relayChoice,
		Agree:         agree,
		EvidenceID:    evidenceID,
	}

	record := map[string]any{
		"schemaVersion": 1,
		"taskId":        taskID,
		"auditor":       auditor,
		"auditorChoice": normalizedAuditor,
		"relayChoice":   relayChoice,
		"agree":         agree,
		"note":          auditorNote,
		"at":            r.now().Format(time.RFC3339),
	}
	recordBody, _ := json.MarshalIndent(record, "", "  ")
	_ = r.store.Comment(ctx, evidenceID, "audit: "+string(recordBody), r.cfg.Actor)

	if agree {
		audit.Reason = "agree"
		_ = r.store.Comment(ctx, taskID, fmt.Sprintf("shadow-audit AGREE: auditor=%s chose %s, relay chose %s", auditor, normalizedAuditor, relayChoice), r.cfg.Actor)
		return audit, nil
	}

	audit.Downgraded = true
	audit.Reason = "audit-disagreement"
	_ = r.store.RemoveLabel(ctx, taskID, store.LabelRoutingReady, r.cfg.Actor)
	if ev.Decision.Route != "" {
		_ = r.store.RemoveLabel(ctx, taskID, store.RouteLabel(ev.Decision.Route), r.cfg.Actor)
	}
	_ = r.store.AddLabel(ctx, taskID, store.LabelRoutingTriage, r.cfg.Actor)
	_ = r.store.AddLabel(ctx, taskID, store.LabelAuditDisagreed, r.cfg.Actor)

	_ = r.store.Comment(ctx, taskID, fmt.Sprintf(
		"shadow-audit DISAGREE: auditor=%s chose %s, relay chose %s -> downgraded to triage; both choices preserved",
		auditor, normalizedAuditor, relayChoice,
	), r.cfg.Actor)

	if r.cfg.SuspensionScope == "class" && ev.Decision.Route != "" {
		workflowID := r.workflowID(ev.Decision.Route)
		for _, ts := range store.TrustStates {
			_ = r.store.RemoveLabel(ctx, workflowID, ts, r.cfg.Actor)
		}
		_ = r.store.AddLabel(ctx, workflowID, store.TrustDowngraded, r.cfg.Actor)
		_ = r.store.Comment(ctx, workflowID, fmt.Sprintf(
			"class-suspension: shadow-audit disagreement on %s (auditor=%s chose %s, relay chose %s)",
			taskID, auditor, normalizedAuditor, relayChoice,
		), r.cfg.Actor)
		audit.Reason = "audit-disagreement-class-suspended"
	}

	return audit, nil
}

func (r *Relay) latestEvidence(ctx context.Context, taskID string) (string, *Evidence, error) {
	beads, err := r.store.Children(ctx, taskID)
	if err != nil {
		return "", nil, err
	}
	var bestID string
	var best *Evidence
	for _, b := range beads {
		if !store.HasAnyLabel(b.Labels, store.LabelKindEvidence) {
			continue
		}
		var ev Evidence
		if err := json.Unmarshal([]byte(b.Body), &ev); err != nil {
			continue
		}
		if best == nil {
			c := ev
			best = &c
			bestID = b.ID
		}
	}
	if best == nil {
		return "", nil, fmt.Errorf("task %s has no relay evidence", taskID)
	}
	return bestID, best, nil
}

func normalizeChoice(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, store.PrefixRoute) {
		return strings.TrimPrefix(s, store.PrefixRoute)
	}
	if s == store.StateClassifiedTriage || s == store.LabelRoutingTriage || s == "agent-triage" {
		return "triage"
	}
	return s
}
