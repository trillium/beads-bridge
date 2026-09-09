package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

type memoryBead struct {
	id        string
	title     string
	body      string
	store     string
	status    string
	parent    string
	labels    map[string]bool
	comments  []string
	createdAt time.Time
}

type MemoryStore struct {
	mu    sync.Mutex
	store string
	beads map[string]*memoryBead
	seq   int
	calls []Call
	now   func() time.Time
}

func NewMemoryStore(storeName string) *MemoryStore {
	return &MemoryStore{
		store: storeName,
		beads: map[string]*memoryBead{},
		now:   func() time.Time { return time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC) },
	}
}

func (m *MemoryStore) Record(call Call) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, call)
}

func (m *MemoryStore) Calls() []Call {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Call, len(m.calls))
	copy(out, m.calls)
	return out
}

func (m *MemoryStore) MethodsCalled() []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range m.Calls() {
		if !seen[c.Method] {
			seen[c.Method] = true
			out = append(out, c.Method)
		}
	}
	sort.Strings(out)
	return out
}

func (m *MemoryStore) StoreName() string { return m.store }

func (m *MemoryStore) nowTS() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.now()
}

func (m *MemoryStore) seed(id string, parent string, title string, body string, labels []string, status string) *MemoryStore {
	m.mu.Lock()
	defer m.mu.Unlock()
	ls := map[string]bool{}
	for _, l := range labels {
		ls[l] = true
	}
	m.beads[id] = &memoryBead{
		id: id, title: title, body: body, store: m.store,
		status: status, parent: parent, labels: ls, comments: []string{},
		createdAt: m.now(),
	}
	return m
}

func (m *MemoryStore) SeedTask(id string, title string, description string, labels []string, status string) *MemoryStore {
	return m.seed(id, "", title, description, labels, status)
}

func (m *MemoryStore) SeedWorkflow(slug string, trust string, def any) (*MemoryStore, string) {
	id := m.store + "-route-" + slug
	defJSON, err := json.Marshal(def)
	if err != nil {
		panic("SeedWorkflow: cannot marshal def: " + err.Error())
	}
	m.seed(id, "", "route workflow "+slug, string(defJSON), []string{LabelKindWorkflow, RouteLabel(slug), trust}, "open")
	return m, id
}

func (m *MemoryStore) CallLogAllows(methods ...string) bool {
	allowed := map[string]bool{}
	for _, x := range methods {
		allowed[x] = true
	}
	for _, c := range m.Calls() {
		if !allowed[c.Method] {
			return false
		}
	}
	return true
}

func (m *MemoryStore) ListTasks(ctx context.Context) ([]Task, error) {
	recordCalls(m, "ListTasks")
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Task
	for _, b := range m.beads {
		if b.parent != "" {
			continue
		}
		if b.status == "" || b.status == "closed" {
			continue
		}
		out = append(out, Task{
			ID: b.id, Store: b.store, Title: b.title, Description: b.body,
			Status: b.status, Parent: b.parent, Labels: m.labelsOf(b),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *MemoryStore) labelsOf(b *memoryBead) []string {
	var out []string
	for l := range b.labels {
		out = append(out, l)
	}
	sort.Strings(out)
	return out
}

func (m *MemoryStore) Task(ctx context.Context, id string) (Task, error) {
	recordCalls(m, "Task", id)
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.beads[id]
	if !ok {
		return Task{}, fmt.Errorf("task %s not found", id)
	}
	return Task{
		ID: b.id, Store: b.store, Title: b.title, Description: b.body,
		Status: b.status, Parent: b.parent, Labels: m.labelsOf(b),
	}, nil
}

func (m *MemoryStore) GetBead(ctx context.Context, id string) (Bead, error) {
	recordCalls(m, "GetBead", id)
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.beads[id]
	if !ok {
		return Bead{}, fmt.Errorf("bead %s not found", id)
	}
	return Bead{
		ID: b.id, Store: b.store, Title: b.title, Body: b.body,
		Labels: m.labelsOf(b), Parent: b.parent, Status: b.status, CreatedAt: b.createdAt,
	}, nil
}

func (m *MemoryStore) Children(ctx context.Context, id string) ([]Bead, error) {
	recordCalls(m, "Children", id)
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Bead
	for _, b := range m.beads {
		if b.parent == id {
			out = append(out, Bead{
				ID: b.id, Store: b.store, Title: b.title, Body: b.body,
				Labels: m.labelsOf(b), Parent: b.parent, Status: b.status, CreatedAt: b.createdAt,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *MemoryStore) BeadsByLabel(ctx context.Context, label string) ([]Bead, error) {
	recordCalls(m, "BeadsByLabel", label)
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Bead
	for _, b := range m.beads {
		if b.labels[label] {
			out = append(out, Bead{
				ID: b.id, Store: b.store, Title: b.title, Body: b.body,
				Labels: m.labelsOf(b), Parent: b.parent, Status: b.status, CreatedAt: b.createdAt,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *MemoryStore) Comments(ctx context.Context, id string) ([]string, error) {
	recordCalls(m, "Comments", id)
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.beads[id]
	if !ok {
		return nil, fmt.Errorf("bead %s not found", id)
	}
	out := make([]string, len(b.comments))
	copy(out, b.comments)
	return out, nil
}

func (m *MemoryStore) AddLabel(ctx context.Context, id string, label string, actor string) error {
	recordCalls(m, "AddLabel", id, label, actor)
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.beads[id]
	if !ok {
		return fmt.Errorf("bead %s not found", id)
	}
	b.labels[label] = true
	return nil
}

func (m *MemoryStore) RemoveLabel(ctx context.Context, id string, label string, actor string) error {
	recordCalls(m, "RemoveLabel", id, label, actor)
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.beads[id]
	if !ok {
		return fmt.Errorf("bead %s not found", id)
	}
	delete(b.labels, label)
	return nil
}

func (m *MemoryStore) Comment(ctx context.Context, id string, body string, actor string) error {
	recordCalls(m, "Comment", id, body, actor)
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.beads[id]
	if !ok {
		return fmt.Errorf("bead %s not found", id)
	}
	b.comments = append(b.comments, body)
	return nil
}

func (m *MemoryStore) CreateBead(ctx context.Context, id string, parent string, title string, body string, labels []string, actor string) (string, error) {
	recordCalls(m, "CreateBead", id, parent, title, actor)
	m.mu.Lock()
	defer m.mu.Unlock()
	if id == "" {
		m.seq++
		if parent != "" {
			id = fmt.Sprintf("%s.%d", parent, m.seq)
		} else {
			id = fmt.Sprintf("%s-b%d", m.store, m.seq)
		}
	}
	if _, exists := m.beads[id]; exists {
		return "", fmt.Errorf("bead %s already exists", id)
	}
	ls := map[string]bool{}
	for _, l := range labels {
		ls[l] = true
	}
	m.beads[id] = &memoryBead{
		id: id, title: title, body: body, store: m.store, status: "open",
		parent: parent, labels: ls, comments: []string{}, createdAt: m.now(),
	}
	return id, nil
}

func (m *MemoryStore) SetState(ctx context.Context, id string, dimension string, value string, reason string, actor string) error {
	recordCalls(m, "SetState", id, dimension, value, reason, actor)
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.beads[id]
	if !ok {
		return fmt.Errorf("bead %s not found", id)
	}
	for l := range b.labels {
		if len(l) > len(dimension)+1 && l[:len(dimension)+1] == dimension+":" {
			delete(b.labels, l)
		}
	}
	b.labels[dimension+":"+value] = true
	if reason != "" {
		b.comments = append(b.comments, fmt.Sprintf("state %s=%s: %s", dimension, value, reason))
	}
	return nil
}
