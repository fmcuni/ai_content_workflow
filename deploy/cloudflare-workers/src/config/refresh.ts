// Ported verbatim from config/refresh.yaml.
// snake_case keys are kept to match Python dict access and minimise divergence.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchedulingConfig {
  default_interval_days: number;
  ok_interval_days: number;
  monitor_interval_days: number;
  retry_interval_days: number;
}

export interface ScanConfig {
  batch_size: number;
  concurrency: number;
  /** Fixed integer key passed to pg_advisory_lock. */
  tick_lock_key: number;
  llm_cap_per_tick: number;
}

export interface ScoringConfig {
  age_full_score_days: number;
  det_high_weight: number;
  det_medium_weight: number;
  llm_weight: number;
  age_weight: number;
  refresh_threshold: number;
  monitor_threshold: number;
}

export interface DeterministicConfig {
  link_check_timeout_ms: number;
  link_check_concurrency: number;
  link_check_ignore_domains: readonly string[];
  dated_phrasing_year_lookback: number;
  audit_det_medium_threshold: number;
}

export interface RefreshConfig {
  scheduling: SchedulingConfig;
  scan: ScanConfig;
  scoring: ScoringConfig;
  deterministic: DeterministicConfig;
}

// ---------------------------------------------------------------------------
// Constant
// ---------------------------------------------------------------------------

const REFRESH_CONFIG: Readonly<RefreshConfig> = {
  scheduling: {
    default_interval_days: 30,
    ok_interval_days: 30,
    monitor_interval_days: 14,
    retry_interval_days: 1,
  },
  scan: {
    batch_size: 200,
    concurrency: 4,
    tick_lock_key: 7421901,
    llm_cap_per_tick: 20,
  },
  scoring: {
    age_full_score_days: 180,
    det_high_weight: 0.2,
    det_medium_weight: 0.1,
    llm_weight: 0.3,
    age_weight: 0.4,
    refresh_threshold: 6.0,
    monitor_threshold: 3.0,
  },
  deterministic: {
    link_check_timeout_ms: 3000,
    link_check_concurrency: 8,
    link_check_ignore_domains: ["facebook.com", "twitter.com", "x.com", "linkedin.com"],
    dated_phrasing_year_lookback: 1,
    audit_det_medium_threshold: 1,
  },
} as const;

/** Return the bundled refresh configuration. */
export function getRefreshConfig(): Readonly<RefreshConfig> {
  return REFRESH_CONFIG;
}
