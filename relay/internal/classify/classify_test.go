package classify

import (
	"testing"
)

func testRoutes() []Route {
	return []Route{
		{
			Slug:       "research",
			PrefixCmds: []string{"route: research"},
			Rules:      []Rule{{Pattern: `\bstudy|survey|literature\b`, Confidence: 0.9, Note: "research-terms"}},
			Keywords:   map[string]float64{"research": 2, "study": 1, "learn": 1, "explore": 1},
		},
		{
			Slug:       "ops",
			PrefixCmds: []string{"route: ops"},
			SuffixCmds: []string{"-> ops"},
			Rules:      []Rule{{Pattern: `\bdeploy your notexist\b`, Confidence: 0.9, Note: "ops-terms"}},
			Keywords:   map[string]float64{"deploy": 2, "ship": 2, "release": 1},
		},
		{
			Slug:     "legal",
			Keywords: map[string]float64{"contract": 3, "legal": 2, "terms": 1},
		},
	}
}

func TestExplicitPrefixForcesRoute(t *testing.T) {
	c := NewClassifier(0.65, "test-v1")
	res := c.Classify("route: research", "", testRoutes())
	if res.Decision.Kind != DecisionRoute || res.Decision.Route != "research" {
		t.Fatalf("want research route, got %+v", res.Decision)
	}
	if res.Decision.Confidence != 1.0 {
		t.Fatalf("want confidence 1.0 from explicit, got %v", res.Decision.Confidence)
	}
	if len(res.Stages) != 1 || res.Stages[0].Name != StageExplicit {
		t.Fatalf("explicit stage should short-circuit, got %d stages", len(res.Stages))
	}
}

func TestExplicitSuffixForcesRoute(t *testing.T) {
	c := NewClassifier(0.65, "test-v1")
	res := c.Classify("move everything -> ops", "", testRoutes())
	if res.Decision.Route != "ops" || res.Decision.Confidence != 1.0 {
		t.Fatalf("suffix should force ops 1.0, got %+v", res.Decision)
	}
}

func TestRuleStageOverridesKeywordsWhenConfident(t *testing.T) {
	c := NewClassifier(0.65, "test-v1")
	res := c.Classify("conduct a survey of market sentiment", "", testRoutes())
	if res.Decision.Route != "research" {
		t.Fatalf("rule engine should route research at 0.9, got %+v", res.Decision)
	}
	if res.Decision.Reason != "rule:research-terms" {
		t.Fatalf("reason should name rule, got %q", res.Decision.Reason)
	}
}

func TestKeywordStageFiresWhenNoExplicitOrRule(t *testing.T) {
	c := NewClassifier(0.65, "test-v1")
	res := c.Classify("research learn explore this question", "", testRoutes())
	if res.Decision.Route != "research" {
		t.Fatalf("keywords should route research, got %+v", res.Decision)
	}
	if len(res.Stages) != 3 {
		t.Fatalf("expected all three stages evaluated, got %d", len(res.Stages))
	}
}

func TestBelowThresholdGoesTriage(t *testing.T) {
	c := NewClassifier(0.65, "test-v1")
	res := c.Classify("just some terms talk", "", testRoutes())
	if res.Decision.Kind != DecisionTriage {
		t.Fatalf("want triage below threshold, got %+v", res.Decision)
	}
	if res.Decision.Confidence >= 0.65 {
		t.Fatalf("below-threshold confidence was %v", res.Decision.Confidence)
	}
}

func TestTieGoesTriage(t *testing.T) {
	c := NewClassifier(0.5, "test-v1")
	legal := Route{Slug: "legal", Keywords: map[string]float64{"x": 1, "y": 1}}
	reqs := Route{Slug: "reqs", Keywords: map[string]float64{"x": 1, "z": 1}}
	res := c.Classify("x", "", []Route{legal, reqs})
	if res.Decision.Kind != DecisionTriage {
		t.Fatalf("equal 0.5 ties should go triage, got %+v", res.Decision)
	}
}

func TestHighestConfidenceWins(t *testing.T) {
	c := NewClassifier(0.5, "test-v1")
	legal := Route{Slug: "legal", Keywords: map[string]float64{"a": 1, "b": 1, "c": 1}}
	tech := Route{Slug: "tech", Keywords: map[string]float64{"a": 1, "x": 1}}
	res := c.Classify("a b c", "", []Route{legal, tech})
	if res.Decision.Kind != DecisionRoute || res.Decision.Route != "legal" {
		t.Fatalf("want legal (1.0 vs 0.5), got %+v", res.Decision)
	}
}

func TestDeterminismAcrossEquivalentCalls(t *testing.T) {
	c := NewClassifier(0.65, "test-v1")
	first := c.Classify("Research this topic immediately", "", testRoutes())
	for i := 0; i < 5; i++ {
		again := c.Classify("Research this topic immediately", "", testRoutes())
		if again.Decision != first.Decision {
			t.Fatalf("non-deterministic result: %+v vs %+v", first.Decision, again.Decision)
		}
	}
}
