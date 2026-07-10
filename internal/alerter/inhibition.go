package alerter

// InhibitionRule suppresses target alerts when a matching source alert is active.
// All non-empty fields must match exactly (empty = wildcard).
type InhibitionRule struct {
	SourceCategory string // e.g. "memory"
	SourceSeverity string // e.g. "critical"
	TargetCategory string // e.g. "queries"
	TargetSeverity string // e.g. "" (any)
}

// InhibitionMatcher checks a set of rules against active alerts.
type InhibitionMatcher struct {
	Rules []InhibitionRule
}

// IsInhibited returns true if the given alert should be suppressed given the
// currently active alerts on the same instance. Inhibition is scoped to a
// single instance: a memory:critical on host-A does not inhibit queries:warn
// on host-B, because the two hosts are independent systems.
func (m *InhibitionMatcher) IsInhibited(alert ActiveAlert, activeAlerts map[string]*ActiveAlert) bool {
	for _, rule := range m.Rules {
		// Check if the candidate alert matches the target side of the rule.
		// Use exact equality to prevent "disk" from inhibiting "disk_usage_warning".
		if rule.TargetCategory != "" && alert.Alert.Category != rule.TargetCategory {
			continue
		}
		if rule.TargetSeverity != "" && string(alert.Alert.Severity) != rule.TargetSeverity {
			continue
		}

		// Check if any active alert on the SAME instance matches the source side.
		for _, active := range activeAlerts {
			if active.Alert.Instance != alert.Alert.Instance {
				continue
			}
			if rule.SourceCategory != "" && active.Alert.Category != rule.SourceCategory {
				continue
			}
			if rule.SourceSeverity != "" && string(active.Alert.Severity) != rule.SourceSeverity {
				continue
			}
			// Found a matching source alert — the candidate is inhibited.
			return true
		}
	}
	return false
}

// DefaultInhibitionRules returns sensible built-in rules:
//   - memory:critical inhibits queries:warn and queries:info
//   - memory:critical inhibits cpu:warn
//   - replication:critical inhibits tables:warn
//   - storage:critical inhibits inserts:warn
func DefaultInhibitionRules() []InhibitionRule {
	return []InhibitionRule{
		{
			SourceCategory: "memory",
			SourceSeverity: "critical",
			TargetCategory: "queries",
			TargetSeverity: "warn",
		},
		{
			SourceCategory: "memory",
			SourceSeverity: "critical",
			TargetCategory: "queries",
			TargetSeverity: "info",
		},
		{
			SourceCategory: "memory",
			SourceSeverity: "critical",
			TargetCategory: "cpu",
			TargetSeverity: "warn",
		},
		{
			SourceCategory: "replication",
			SourceSeverity: "critical",
			TargetCategory: "tables",
			TargetSeverity: "warn",
		},
		{
			SourceCategory: "storage",
			SourceSeverity: "critical",
			TargetCategory: "inserts",
			TargetSeverity: "warn",
		},
		{
			// Broken replication makes replicas read-only / rejects inserts, so
			// the insert-failure warnings are downstream symptoms of the same root
			// cause. (Keeper is the root of this chain, but keeper alerts are
			// categorised "system"; the replication:critical alert is the reliable
			// proximate signal to inhibit on.)
			SourceCategory: "replication",
			SourceSeverity: "critical",
			TargetCategory: "inserts",
			TargetSeverity: "warn",
		},
	}
}
