package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type Runner func(ctx context.Context, argv []string, stdin string, timeout time.Duration) (string, error)

type CLIStore struct {
	store   string
	timeout time.Duration
	runner  Runner
	now     func() time.Time
}

func NewCLIStore(storeName string) *CLIStore {
	return &CLIStore{
		store:   storeName,
		timeout: 10 * time.Second,
		runner:  defaultRunner,
		now:     func() time.Time { return time.Now().UTC() },
	}
}

func WithRunner(r Runner) func(*CLIStore) {
	return func(c *CLIStore) { c.runner = r }
}

func WithTimeout(d time.Duration) func(*CLIStore) {
	return func(c *CLIStore) { c.timeout = d }
}

func defaultRunner(ctx context.Context, argv []string, stdin string, timeout time.Duration) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, argv[0], argv[1:]...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return string(ee.Stderr), fmt.Errorf("%s: %w: %s", argv[0], err, strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("%s: %w", argv[0], err)
	}
	return strings.TrimSpace(string(out)), nil
}

func (c *CLIStore) StoreName() string { return c.store }

func (c *CLIStore) run(ctx context.Context, stdin string, args ...string) (string, error) {
	argv := append([]string{c.store}, args...)
	return c.runner(ctx, argv, stdin, c.timeout)
}

func (c *CLIStore) ListTasks(ctx context.Context) ([]Task, error) {
	out, err := c.run(ctx, "", "list", "--status", "open", "--json")
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID          string   `json:"id"`
		Title       string   `json:"title"`
		Description string   `json:"description"`
		Status      string   `json:"status"`
		Parent      string   `json:"parent"`
		Labels      []string `json:"labels"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		return nil, fmt.Errorf("parse list --json: %w: %s", err, out)
	}
	var tasks []Task
	for _, r := range rows {
		tasks = append(tasks, Task{
			ID: r.ID, Store: c.store, Title: r.Title, Description: r.Description,
			Status: r.Status, Parent: r.Parent, Labels: r.Labels,
		})
	}
	return tasks, nil
}

func (c *CLIStore) Task(ctx context.Context, id string) (Task, error) {
	out, err := c.run(ctx, "", "show", id, "--json")
	if err != nil {
		return Task{}, err
	}
	return parseTaskJSON(out, c.store)
}

func (c *CLIStore) GetBead(ctx context.Context, id string) (Bead, error) {
	out, err := c.run(ctx, "", "show", id, "--json")
	if err != nil {
		return Bead{}, err
	}
	var rows []struct {
		ID     string   `json:"id"`
		Title  string   `json:"title"`
		Body   string   `json:"description"`
		Status string   `json:"status"`
		Parent string   `json:"parent"`
		Labels []string `json:"labels"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		return Bead{}, fmt.Errorf("parse show --json: %w: %s", err, out)
	}
	if len(rows) == 0 {
		return Bead{}, fmt.Errorf("bead %s not found", id)
	}
	r := rows[0]
	return Bead{
		ID: r.ID, Store: c.store, Title: r.Title, Body: r.Body,
		Labels: r.Labels, Parent: r.Parent, Status: r.Status,
	}, nil
}

func (c *CLIStore) Children(ctx context.Context, id string) ([]Bead, error) {
	out, err := c.run(ctx, "", "children", id, "--json")
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID     string   `json:"id"`
		Title  string   `json:"title"`
		Body   string   `json:"description"`
		Status string   `json:"status"`
		Parent string   `json:"parent"`
		Labels []string `json:"labels"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		return nil, fmt.Errorf("parse children --json: %w: %s", err, out)
	}
	var beads []Bead
	for _, r := range rows {
		beads = append(beads, Bead{
			ID: r.ID, Store: c.store, Title: r.Title, Body: r.Body,
			Labels: r.Labels, Parent: r.Parent, Status: r.Status,
		})
	}
	return beads, nil
}

func (c *CLIStore) BeadsByLabel(ctx context.Context, label string) ([]Bead, error) {
	out, err := c.run(ctx, "", "list", "--label", label, "--status", "all", "--json")
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID     string   `json:"id"`
		Title  string   `json:"title"`
		Body   string   `json:"description"`
		Status string   `json:"status"`
		Parent string   `json:"parent"`
		Labels []string `json:"labels"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		return nil, fmt.Errorf("parse list --json: %w: %s", err, out)
	}
	var beads []Bead
	for _, r := range rows {
		beads = append(beads, Bead{
			ID: r.ID, Store: c.store, Title: r.Title, Body: r.Body,
			Labels: r.Labels, Parent: r.Parent, Status: r.Status,
		})
	}
	return beads, nil
}

func (c *CLIStore) Comments(ctx context.Context, id string) ([]string, error) {
	out, err := c.run(ctx, "", "comments", id, "--json")
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Body string `json:"body"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		return nil, fmt.Errorf("parse comments --json: %w: %s", err, out)
	}
	var bodies []string
	for _, r := range rows {
		bodies = append(bodies, r.Body)
	}
	return bodies, nil
}

func (c *CLIStore) AddLabel(ctx context.Context, id string, label string, actor string) error {
	args := []string{"label", "add", id, label}
	if actor != "" {
		args = append(args, "--actor", actor)
	}
	_, err := c.run(ctx, "", args...)
	return err
}

func (c *CLIStore) RemoveLabel(ctx context.Context, id string, label string, actor string) error {
	args := []string{"label", "remove", id, label}
	if actor != "" {
		args = append(args, "--actor", actor)
	}
	_, err := c.run(ctx, "", args...)
	return err
}

func (c *CLIStore) Comment(ctx context.Context, id string, body string, actor string) error {
	args := []string{"comment", id, body}
	if actor != "" {
		args = append(args, "--actor", actor)
	}
	_, err := c.run(ctx, "", args...)
	return err
}

func (c *CLIStore) CreateBead(ctx context.Context, id string, parent string, title string, body string, labels []string, actor string) (string, error) {
	args := []string{"create", title}
	if id != "" {
		args = append(args, "--id", id)
	}
	if parent != "" {
		args = append(args, "--parent", parent)
	}
	if len(labels) > 0 {
		args = append(args, "--labels", strings.Join(labels, ","))
	}
	if actor != "" {
		args = append(args, "--actor", actor)
	}
	out, err := c.run(ctx, body, append(args, "--description", "-")...)
	if err != nil {
		return "", err
	}
	return parseCreatedID(out), nil
}

func (c *CLIStore) SetState(ctx context.Context, id string, dimension string, value string, reason string, actor string) error {
	args := []string{"set-state", id, dimension + "=" + value, "--reason", reason, "--actor", actor}
	_, err := c.run(ctx, "", args...)
	return err
}

func parseTaskJSON(out string, storeName string) (Task, error) {
	var rows []struct {
		ID          string   `json:"id"`
		Title       string   `json:"title"`
		Description string   `json:"description"`
		Status      string   `json:"status"`
		Parent      string   `json:"parent"`
		Labels      []string `json:"labels"`
	}
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		return Task{}, fmt.Errorf("parse show --json: %w: %s", err, out)
	}
	if len(rows) == 0 {
		return Task{}, fmt.Errorf("task not found")
	}
	r := rows[0]
	return Task{
		ID: r.ID, Store: storeName, Title: r.Title, Description: r.Description,
		Status: r.Status, Parent: r.Parent, Labels: r.Labels,
	}, nil
}

func parseCreatedID(out string) string {
	fields := strings.Fields(out)
	for i := len(fields) - 1; i >= 0; i-- {
		f := fields[i]
		if strings.Contains(f, "-") && len(f) >= 4 {
			return strings.Trim(f, "\"',.:")
		}
	}
	return strings.TrimSpace(out)
}
