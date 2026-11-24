package classify

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const (
	StageExplicit = "explicit"
	StageRules    = "rules"
	StageKeywords = "keywords"

	DecisionRoute  = "route"
	DecisionTriage = "triage"
)

type Rule struct {
	Pattern    string
	Confidence float64
	Note       string
}

type Route struct {
	Slug       string
	PrefixCmds []string
	SuffixCmds []string
	Rules      []Rule
	Keywords   map[string]float64
}

type Candidate struct {
	Route      string
	Confidence float64
	Reason     string
}

type Stage struct {
	Name       string
	Evaluated  bool
	SkipReason string
	Candidates []Candidate
}

type Decision struct {
	Kind       string
	Route      string
	Confidence float64
	Reason     string
}

type Result struct {
	Decision Decision
	Stages   []Stage
}

type Classifier struct {
	threshold    float64
	rulesVersion string
}

func NewClassifier(threshold float64, rulesVersion string) *Classifier {
	return &Classifier{threshold: threshold, rulesVersion: rulesVersion}
}

func (c *Classifier) Threshold() float64   { return c.threshold }
func (c *Classifier) RulesVersion() string { return c.rulesVersion }

func (c *Classifier) Classify(title string, description string, routes []Route) Result {
	text := title
	if description != "" {
		text = title + "\n" + description
	}
	normalized := normalize(text)
	sorted := append([]Route(nil), routes...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Slug < sorted[j].Slug })

	var stages []Stage

	explicit := c.stageExplicit(normalized, sorted)
	stages = append(stages, explicit)
	decision, done := adopt(stages, c.threshold)
	if done {
		return Result{Decision: decision, Stages: stages}
	}

	rules := c.stageRules(normalized, sorted)
	stages = append(stages, rules)
	decision, done = adopt(stages, c.threshold)
	if done {
		return Result{Decision: decision, Stages: stages}
	}

	keywords := c.stageKeywords(normalized, sorted)
	stages = append(stages, keywords)
	decision, done = adopt(stages, c.threshold)
	if done {
		return Result{Decision: decision, Stages: stages}
	}

	return Result{
		Decision: Decision{
			Kind:   DecisionTriage,
			Route:  "",
			Reason: "insufficient-two-or-more-tied",
		},
		Stages: stages,
	}
}

func (c *Classifier) stageExplicit(text string, routes []Route) Stage {
	stage := Stage{Name: StageExplicit, Evaluated: true}
	for _, r := range routes {
		for _, p := range r.PrefixCmds {
			pc := normalize(p)
			if strings.HasPrefix(text, pc) {
				stage.Candidates = append(stage.Candidates, Candidate{
					Route: r.Slug, Confidence: 1.0, Reason: "prefix:" + p,
				})
			}
		}
		for _, s := range r.SuffixCmds {
			sc := normalize(s)
			if strings.HasSuffix(text, sc) {
				stage.Candidates = append(stage.Candidates, Candidate{
					Route: r.Slug, Confidence: 1.0, Reason: "suffix:" + s,
				})
			}
		}
	}
	return stage
}

func (c *Classifier) stageRules(text string, routes []Route) Stage {
	stage := Stage{Name: StageRules, Evaluated: true}
	for _, r := range routes {
		best := 0.0
		bestReason := ""
		for _, rule := range r.Rules {
			re, err := regexp.Compile(`(?i)` + rule.Pattern)
			if err != nil {
				continue
			}
			if re.MatchString(text) && rule.Confidence > best {
				best = rule.Confidence
				bestReason = "rule:" + rule.Pattern
				if rule.Note != "" {
					bestReason = "rule:" + rule.Note
				}
			}
		}
		if best > 0 {
			stage.Candidates = append(stage.Candidates, Candidate{
				Route: r.Slug, Confidence: best, Reason: bestReason,
			})
		}
	}
	return stage
}

func (c *Classifier) stageKeywords(text string, routes []Route) Stage {
	stage := Stage{Name: StageKeywords, Evaluated: true}
	tokens := tokenSet(text)
	for _, r := range routes {
		if len(r.Keywords) == 0 {
			continue
		}
		score := 0.0
		total := 0.0
		var hit []string
		for kw, w := range r.Keywords {
			total += w
			if tokens[normalize(kw)] {
				score += w
				hit = append(hit, kw)
			}
		}
		if total == 0 || score == 0 {
			continue
		}
		conf := score / total
		stage.Candidates = append(stage.Candidates, Candidate{
			Route: r.Slug, Confidence: conf,
			Reason: "keywords:" + strings.Join(hit, "+"),
		})
	}
	return stage
}

func adopt(stages []Stage, threshold float64) (Decision, bool) {
	if len(stages) == 0 {
		return Decision{}, false
	}
	last := stages[len(stages)-1]
	if !last.Evaluated {
		return Decision{}, false
	}
	if len(last.Candidates) == 0 {
		return Decision{}, false
	}
	sorted := append([]Candidate(nil), last.Candidates...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Confidence == sorted[j].Confidence {
			return sorted[i].Route < sorted[j].Route
		}
		return sorted[i].Confidence > sorted[j].Confidence
	})
	best := sorted[0]
	if best.Confidence < threshold {
		return Decision{
			Kind: DecisionTriage, Route: "",
			Confidence: best.Confidence,
			Reason:     fmt.Sprintf("below-threshold-best-confidence-%.3g", best.Confidence),
		}, true
	}
	if len(sorted) > 1 && sorted[1].Confidence+1e-9 >= best.Confidence {
		return Decision{
			Kind: DecisionTriage, Route: "",
			Confidence: best.Confidence,
			Reason:     "tied-best-candidates-" + sorted[0].Route + "-" + sorted[1].Route,
		}, true
	}
	return Decision{
		Kind: DecisionRoute, Route: best.Route,
		Confidence: best.Confidence, Reason: best.Reason,
	}, true
}

func normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return collapseSpace(s)
}

func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func tokenSet(s string) map[string]bool {
	fields := strings.FieldsFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9')
	})
	out := map[string]bool{}
	for _, f := range fields {
		out[f] = true
	}
	return out
}
