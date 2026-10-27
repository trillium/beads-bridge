package store

import (
	"context"
	"time"
)

const (
	LabelRoutingReady     = "routing:ready"
	LabelRoutingTriage    = "routing:triage"
	LabelAuditDisagreed   = "audit:disagreed"
	LabelKindWorkflow     = "kind:workflow"
	LabelKindEvidence     = "kind:evidence"
	PrefixRoute           = "route:"
	PrefixTrust           = "trust:"
	TrustProvisional      = "trust:provisional"
	TrustTrusted          = "trust:trusted"
	TrustDowngraded       = "trust:downgraded"
	StateClassified       = "routing"
	StateClassifiedYes    = "classified"
	StateClassifiedTriage = "triage"
)

var (
	TrustStates = []string{TrustProvisional, TrustTrusted, TrustDowngraded}
)

func RouteLabel(slug string) string {
	return PrefixRoute + slug
}

func TrustLabel(state string) string {
	return PrefixTrust + state
}

func TrustStateFromLabels(labels []string) string {
	for _, l := range labels {
		if len(l) > len(PrefixTrust) && l[:len(PrefixTrust)] == PrefixTrust {
			return l
		}
	}
	return TrustProvisional
}

func HasAnyLabel(labels []string, want ...string) bool {
	have := map[string]bool{}
	for _, l := range labels {
		have[l] = true
	}
	for _, w := range want {
		if have[w] {
			return true
		}
	}
	return false
}

func HasPrefixLabel(labels []string, prefix string) bool {
	for _, l := range labels {
		if len(l) > len(prefix) && l[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

type Task struct {
	ID          string
	Store       string
	Title       string
	Description string
	Status      string
	Parent      string
	Labels      []string
}

type Bead struct {
	ID        string
	Store     string
	Title     string
	Body      string
	Labels    []string
	Parent    string
	Status    string
	CreatedAt time.Time
}

type Call struct {
	Method string
	Args   []string
}

type Store interface {
	StoreName() string
	ListTasks(ctx context.Context) ([]Task, error)
	Task(ctx context.Context, id string) (Task, error)
	GetBead(ctx context.Context, id string) (Bead, error)
	Children(ctx context.Context, id string) ([]Bead, error)
	BeadsByLabel(ctx context.Context, label string) ([]Bead, error)
	Comments(ctx context.Context, id string) ([]string, error)
	AddLabel(ctx context.Context, id string, label string, actor string) error
	RemoveLabel(ctx context.Context, id string, label string, actor string) error
	Comment(ctx context.Context, id string, body string, actor string) error
	CreateBead(ctx context.Context, id string, parent string, title string, body string, labels []string, actor string) (string, error)
	SetState(ctx context.Context, id string, dimension string, value string, reason string, actor string) error
}

type recorder interface {
	Record(Call)
}

func recordCalls(s Store, method string, args ...string) {
	if r, ok := s.(recorder); ok {
		r.Record(Call{Method: method, Args: args})
	}
}
