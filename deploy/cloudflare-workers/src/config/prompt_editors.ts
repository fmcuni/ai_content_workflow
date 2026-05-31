// Ported verbatim from config/prompt_editors.yaml.
// Gates the (later-phase) /prompts write endpoints.
//
// Authentication model (mirrors the Python backend):
//   - The reverse proxy validates the editor's SSO session and injects
//     X-Editor-Email before forwarding. This module checks that header value
//     against the allowlist (case-insensitive).
//   - Anyone in the editors list can save and revert prompt templates.
//   - Anyone outside is rejected with 403 unless dev_mode is active.
//
// dev_mode override:
//   - The YAML sets dev_mode:true for local development.
//   - CI and production set PROMPT_EDITOR_DEV_MODE=false via env, which takes
//     precedence over the bundled value on every check.
//   - Workers reads env from the `env` binding object, NOT process.env, so
//     callers must pass the env object (or an equivalent subset) to isAllowed().

// ---------------------------------------------------------------------------
// Raw constant
// ---------------------------------------------------------------------------

const PROMPT_EDITOR_RAW = {
  editors: ["franco.ma@bowtie.com.sg"],
  dev_mode: true,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal env-binding shape needed by PromptEditorPolicy. */
export interface PromptEditorEnv {
  PROMPT_EDITOR_DEV_MODE?: string;
}

// ---------------------------------------------------------------------------
// PromptEditorPolicy
// ---------------------------------------------------------------------------

export class PromptEditorPolicy {
  /** Allowlisted editors, normalised to lowercase. */
  private readonly editors: ReadonlySet<string>;
  /** Bundled dev_mode flag from YAML (may be overridden by env). */
  private readonly bundledDevMode: boolean;

  constructor() {
    this.editors = new Set(PROMPT_EDITOR_RAW.editors.map((e) => e.toLowerCase()));
    this.bundledDevMode = PROMPT_EDITOR_RAW.dev_mode;
  }

  /**
   * Resolve whether dev_mode is active.
   *
   * The env binding's PROMPT_EDITOR_DEV_MODE string takes precedence:
   *   "false" (case-insensitive) → false
   *   "true"  (case-insensitive) → true
   *   absent / other             → fall back to bundled YAML value
   */
  private resolveDevMode(env: PromptEditorEnv | null | undefined): boolean {
    const envVal = env?.PROMPT_EDITOR_DEV_MODE;
    if (envVal !== undefined) {
      return envVal.toLowerCase() !== "false";
    }
    return this.bundledDevMode;
  }

  /**
   * Return true if the given email is permitted to write prompt templates.
   *
   * @param email       The X-Editor-Email header value forwarded by the proxy.
   * @param env         The Workers env binding (pass `env` from the fetch handler).
   *                    When dev_mode is active the gate is skipped and any email
   *                    is allowed (stamped as-is, or "dev@local" when absent).
   */
  isAllowed(email: string | null | undefined, env?: PromptEditorEnv | null): boolean {
    if (this.resolveDevMode(env)) {
      return true;
    }
    if (!email) return false;
    return this.editors.has(email.toLowerCase());
  }
}

/** Singleton instance — import this for normal use. */
export const promptEditorPolicy = new PromptEditorPolicy();
