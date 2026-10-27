package config

import (
	"fmt"
	"os"
	"strconv"
)

type Promotion struct {
	MinValidationAgreements int
	AutoPromote             bool
	RequiresHumanApproval   bool
}

type Config struct {
	Store                  string
	ConfidenceThreshold    float64
	RulesVersion           string
	AllowProvisionalRoutes bool
	SuspensionScope        string
	Actor                  string
	Promotion              Promotion
}

func Default() Config {
	return Config{
		Store:                  "task",
		ConfidenceThreshold:    0.65,
		RulesVersion:           "relay-1",
		AllowProvisionalRoutes: false,
		SuspensionScope:        "task",
		Actor:                  "relay",
		Promotion: Promotion{
			MinValidationAgreements: 10,
			AutoPromote:             false,
			RequiresHumanApproval:   true,
		},
	}
}

func (c Config) Validate() error {
	if c.Store == "" {
		return fmt.Errorf("config: Store must not be empty")
	}
	if c.ConfidenceThreshold < 0 || c.ConfidenceThreshold > 1 {
		return fmt.Errorf("config: ConfidenceThreshold must be in [0,1], got %v", c.ConfidenceThreshold)
	}
	if c.RulesVersion == "" {
		return fmt.Errorf("config: RulesVersion must not be empty")
	}
	if c.SuspensionScope != "task" && c.SuspensionScope != "class" {
		return fmt.Errorf("config: SuspensionScope must be \"task\" or \"class\", got %q", c.SuspensionScope)
	}
	if c.Actor == "" {
		return fmt.Errorf("config: Actor must not be empty")
	}
	if c.Promotion.MinValidationAgreements < 1 {
		return fmt.Errorf("config: Promotion.MinValidationAgreements must be >= 1")
	}
	return nil
}

func FromEnv() Config {
	c := Default()
	if v, ok := os.LookupEnv("RELAY_STORE"); ok && v != "" {
		c.Store = v
	}
	if v, ok := os.LookupEnv("RELAY_THRESHOLD"); ok && v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			c.ConfidenceThreshold = f
		}
	}
	if v, ok := os.LookupEnv("RELAY_RULES_VERSION"); ok && v != "" {
		c.RulesVersion = v
	}
	if v, ok := os.LookupEnv("RELAY_ALLOW_PROVISIONAL"); ok && v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			c.AllowProvisionalRoutes = b
		}
	}
	if v, ok := os.LookupEnv("RELAY_SUSPENSION_SCOPE"); ok && v != "" {
		c.SuspensionScope = v
	}
	if v, ok := os.LookupEnv("RELAY_ACTOR"); ok && v != "" {
		c.Actor = v
	}
	return c
}
