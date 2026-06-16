import type { VoiceConfigTab } from "./VoiceConfigInspector";

// Single source of truth for the voice-studio canvas node-id scheme. IDs are
// minted here (used by layout.ts) and classified here (used by the page's
// selection resolver), so the prefix strings never drift between the two sides.

const GATE = "gate:";
const PARTIAL = "partial:";
const CONTEXT = "context:";

/** The header "Voice settings" button and both context nodes open this inspector. */
export const VOICE_SETTINGS_ID = "voice:settings";

/** Context kinds that surface as canvas nodes (a subset of VoiceConfigTab). */
export type ContextNodeKind = "locale" | "source_policy";

export const gateId = (id: string): string => `${GATE}${id}`;
export const partialId = (templateId: string): string => `${PARTIAL}${templateId}`;
export const contextId = (kind: ContextNodeKind): string => `${CONTEXT}${kind}`;

export type NodeIdClass =
  | { kind: "voice-settings" }
  | { kind: "context"; tab: VoiceConfigTab }
  | { kind: "partial"; templateId: string }
  | { kind: "gate"; id: string }
  | { kind: "agent"; id: string };

/**
 * Syntactic classification of a canvas node id. `agent` is the fall-through —
 * the caller resolves `agent` and `gate` against the loaded graph, so an id
 * matching no graph node simply yields no selection there. The colon in a
 * gate/partial suffix is safe: slice() takes the whole remainder after the
 * fixed prefix.
 */
export function classifyNodeId(id: string): NodeIdClass {
  if (id === VOICE_SETTINGS_ID) return { kind: "voice-settings" };
  if (id === contextId("locale")) return { kind: "context", tab: "locale" };
  if (id === contextId("source_policy")) return { kind: "context", tab: "source_policy" };
  if (id.startsWith(PARTIAL)) return { kind: "partial", templateId: id.slice(PARTIAL.length) };
  if (id.startsWith(GATE)) return { kind: "gate", id: id.slice(GATE.length) };
  return { kind: "agent", id };
}
