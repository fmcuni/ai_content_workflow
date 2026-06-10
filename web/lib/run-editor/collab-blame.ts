import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

import type { DiffPart, Hunk, HunkAuthor, TrackedChanges } from "@/lib/tracked-changes";
import { NEUTRAL_COLLAB_COLOR, safeCollabColor } from "@/lib/run-editor/collab-color";

/**
 * Per-author attribution ("blame") for the Review panel's tracked changes.
 *
 * The Review engine (`lib/tracked-changes.ts`) is an HTML-AWARE STRING DIFF of
 * the committed baseline vs the working body — its hunks carry HTML-token offsets
 * on the working/committed side, NOT ProseMirror or Yjs positions. Authorship,
 * however, lives in Yjs: `Y.PermanentUserData` maps a clientID → user (inserts)
 * and a deleted item's id → user (deletions). This module bridges the two.
 *
 * The bridge (proven by the Phase-4 spike) DRIVES OFF THE DIFF PARTS rather than
 * reconstructing positions. The diff already states, in document order, which
 * runs are unchanged / added / removed. Walking the shared Yjs doc yields, in the
 * SAME document order, the live characters (with their inserter) and the deleted
 * characters (with their id). So we consume:
 *   - `added`   working text → the next live chars  → getUserByClientId  (inserter)
 *   - `removed` committed text → the next deleted chars → getUserByDeletedId (deleter)
 *   - `unchanged` text advances the live cursor only (keeps `added` aligned).
 *
 * Two coarsenings, both expected and accepted:
 *   1. FAQ widgets are an ATOM node — their Q/A text lives in a node attribute and
 *      is re-emitted by `renderHTML`, so it is NOT Yjs character data. Atom text is
 *      detected in the token stream (the `editor__faq` wrapper), skipped from the
 *      char cursors (so prose AFTER a widget stays aligned), and attributed at the
 *      NODE level to the widget's author.
 *   2. A string-diff hunk can span several authors (its boundaries are diff
 *      artifacts, not authorship boundaries), so a hunk is attributed to its
 *      DOMINANT author (plurality of resolved characters).
 *
 * Everything here is PURE + CLIENT-SIDE and reads the doc read-only. When no
 * resolver is supplied the hunks keep `author === undefined`, so the diff and the
 * popover render byte-identically to the non-collab path.
 */

/** The atom node whose text is attribute-stored (re-emitted by renderHTML), so it
 *  never appears as Yjs character data — must mirror the FaqAccordion node name. */
const FAQ_ATOM_NODE = "faqAccordion";

const TAG_RE = /^<[^>]*>$/;
const isTag = (token: string): boolean => TAG_RE.test(token);

/** Decoded code-unit length of a NON-tag text token.
 *
 * The diff (`computeTrackedChanges`) runs over ProseMirror `getHTML()` output,
 * which ENTITY-ESCAPES `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;` (and `"`→`&quot;`) in
 * text content. The Yjs char stream (`scan.liveChars`/`scan.delChars`) instead
 * holds the DECODED characters — one entry per UTF-16 code unit of the stored
 * `ContentString.str`, where `&amp;` is a single `&`. Advancing the cursors by the
 * raw `token.length` therefore OVERSHOOTS by the entity expansion (e.g. `&amp;` is
 * +4) and desyncs every downstream attribution for the rest of the document, so a
 * hunk after any entity loses its author (the reported "missing user name per
 * change"). Measure the decoded length instead. Counts UTF-16 code units to match
 * `walk()`'s `j < str.length` loop. `&amp;` is decoded LAST so `&amp;lt;` does not
 * double-decode into `<`. */
function decodedTextLen(token: string): number {
  const decoded = token
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
  return decoded.length;
}
/** Opening `<div …>` (not the self-less close). */
const isDivOpen = (token: string): boolean => /^<div(?:\s|>)/i.test(token);
const isDivClose = (token: string): boolean => token.toLowerCase() === "</div>";
/** The FAQ atom's wrapper open tag. */
const isFaqOpen = (token: string): boolean =>
  isDivOpen(token) && /\beditor__faq\b/.test(token);

/** One live character: its inserter clientID. */
interface LiveChar {
  client: number;
}
/** One deleted (tombstoned) character: the id used for getUserByDeletedId. */
interface DelChar {
  id: Y.ID;
}
/** A FAQ atom element in document order. `client` attributes a LIVE atom
 *  (getUserByClientId); `id` attributes a DELETED one (getUserByDeletedId). */
interface AtomEl {
  client: number;
  id: Y.ID;
  deleted: boolean;
  /** ClientID of the most recent `items` attribute write. Per-item add/edit/
   *  DELETE inside a live widget is an attribute rewrite (the Q/A pairs live in
   *  node attrs, not Yjs chars), so this — not the element's inserter — names
   *  who made the latest item-level change. Null when unreadable. */
  attrClient: number | null;
}

/** Last writer of the FAQ atom's `items` attribute. Yjs keeps the CURRENT
 *  attribute item per key in the element type's `_map`; its item id carries the
 *  writer's clientID. Duck-typed + defensive, like the rest of the walk. */
function lastItemsAttrClient(child: unknown): number | null {
  const map = (child as { _map?: Map<string, { id?: { client?: unknown } }> })._map;
  const client = map?.get?.("items")?.id?.client;
  return typeof client === "number" ? client : null;
}

interface DocScan {
  liveChars: LiveChar[];
  delChars: DelChar[];
  /** Live atoms in document order (working-side ordinals). */
  liveAtoms: AtomEl[];
  /** Deleted atoms in document order (removed-side ordinals). */
  delAtoms: AtomEl[];
}

/** Walk a Yjs type's internal item list in document order, collecting live chars,
 *  deleted chars and FAQ atom elements. Zero-width mark items (ContentFormat) and
 *  embeds carry no character, so they are skipped — which is exactly why the live
 *  char stream aligns byte-for-byte with the flattened text (minus atoms). */
function walk(type: unknown, scan: DocScan): void {
  // Internal item traversal (._start / .right) — the stable mechanism y-prosemirror
  // itself relies on; there is no public per-item iterator.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let item: any = (type as { _start?: unknown })._start ?? null;
  while (item) {
    const content = item.content;
    // DUCK-TYPE on content shape, NOT `content.constructor.name`: yjs's internal
    // Content* classes are renamed by the production minifier (Turbopack), so a
    // `=== "ContentString"` name check silently matches NOTHING in prod — the doc
    // scans clean and every hunk loses its author. `ContentString` is the only
    // content carrying a string `.str`; `ContentType` is the only one carrying a
    // nested `.type` (an AbstractType). ContentFormat/Embed/Deleted carry neither,
    // so they fall through and contribute no character (as before).
    const str: unknown = content?.str;
    const childType: unknown = content?.type;
    if (typeof str === "string") {
      if (item.deleted) {
        // Every char in this item was deleted by one transaction, so they share
        // the item's id; the delete-set is range-based, so the item-start id
        // resolves the deleter for the whole run.
        const itemId = Y.createID(item.id.client, item.id.clock);
        for (let j = 0; j < str.length; j++) scan.delChars.push({ id: itemId });
      } else {
        for (let j = 0; j < str.length; j++) scan.liveChars.push({ client: item.id.client });
      }
    } else if (childType && typeof childType === "object") {
      const child = content.type;
      if (!child) {
        item = item.right; // partially-synced nested type — skip, never throw
        continue;
      }
      const nodeName: string | null = child.nodeName ?? null;
      if (nodeName === FAQ_ATOM_NODE) {
        const atom: AtomEl = {
          client: item.id.client,
          id: Y.createID(item.id.client, item.id.clock),
          deleted: !!item.deleted,
          attrClient: lastItemsAttrClient(child),
        };
        (atom.deleted ? scan.delAtoms : scan.liveAtoms).push(atom);
        // Do NOT recurse — the atom's text is in attributes, not Yjs chars.
      } else {
        walk(child, scan);
      }
    }
    // ContentFormat / ContentEmbed / ContentDeleted etc. contribute no character.
    item = item.right;
  }
}

function scanDoc(ydoc: Y.Doc): DocScan {
  const scan: DocScan = { liveChars: [], delChars: [], liveAtoms: [], delAtoms: [] };
  // "default" mirrors the Collaboration extension's `field` option (see
  // editor-extensions.ts) — the fragment the body lives in.
  walk(ydoc.getXmlFragment("default"), scan);
  return scan;
}

/** Plurality winner among resolved names (ties → first to reach the max). */
function dominant(names: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const n of names) if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  counts.forEach((count, name) => {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  });
  return best;
}

/** Per-side cursor state tracking FAQ-atom nesting depth + the atom ordinal. */
interface SideState {
  inAtomDepth: number;
  /** How many atoms have been ENTERED on this side so far. */
  atomOrd: number;
  /** Whether the CURRENT atom was entered via a wrapper tag in a REMOVED part
   *  (whole widget deleted → tombstoned element, deleted-atom ordinals) as
   *  opposed to an unchanged wrapper (live widget, per-item attr rewrite). */
  enteredViaRemoved: boolean;
}

/** Build a name → colour map from the current peers' awareness (server-issued,
 *  per-session colours). Authors not currently connected fall back to neutral. */
function buildColourMap(awareness: Awareness | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!awareness) return map;
  awareness.getStates().forEach((state) => {
    const user = (state as { user?: { name?: unknown; color?: unknown } })?.user;
    if (user && typeof user.name === "string" && typeof user.color === "string") {
      map.set(user.name, safeCollabColor(user.color));
    }
  });
  return map;
}

/** Build a clientID → display-name map from the current peers' awareness.
 *
 *  This is the AUTHORITATIVE source for currently-connected editors: awareness is
 *  keyed by the live `doc.clientID` — the exact id every inserted char carries —
 *  and always reflects the session's current name. The `users` Y.Map that
 *  `PermanentUserData` reads is keyed by DISPLAY NAME, so two sessions of the same
 *  person (e.g. the same operator re-opening a persisted run) collide on one key;
 *  syncing the stored doc in then resolves that `Y.Map` key conflict to a single
 *  winner, stranding the loser's clientID — non-deterministically the current
 *  session's OR a prior one's, depending on which random clientID sorts higher.
 *  Awareness sidesteps that entirely. PermanentUserData stays the fallback for
 *  authors who have since disconnected (no awareness entry). */
function buildAwarenessNameMap(awareness: Awareness | null | undefined): Map<number, string> {
  const map = new Map<number, string>();
  if (!awareness) return map;
  awareness.getStates().forEach((state, clientId) => {
    const user = (state as { user?: { name?: unknown } })?.user;
    if (user && typeof user.name === "string") map.set(clientId, user.name);
  });
  return map;
}

/** A read-only attribution view over a live shared doc. `annotate` returns the
 *  tracked-changes hunks with `author` filled in where it can be resolved. */
export interface BlameResolver {
  annotate(tracked: TrackedChanges): Hunk[];
}

/**
 * Build a blame resolver from a live shared Yjs doc (and optionally the awareness
 * for colours). Returns null when there is no doc, so callers can pass the result
 * straight through and the no-collab path stays untouched.
 */
export function buildBlameResolver(
  ydoc: Y.Doc | null | undefined,
  awareness?: Awareness | null,
): BlameResolver | null {
  if (!ydoc) return null;
  // Read-only view of the synced authorship metadata (the `users` map).
  const pud = new Y.PermanentUserData(ydoc);

  return {
    annotate(tracked: TrackedChanges): Hunk[] {
      const { parts, hunks } = tracked;
      if (hunks.length === 0) return hunks;

      // Reading Yjs internals must never break the reviewer's accept/reject flow:
      // on any walk error, fall back to unattributed hunks.
      let scan: DocScan;
      try {
        scan = scanDoc(ydoc);
      } catch (err: unknown) {
        console.warn("collab-blame: doc scan failed; rendering changes without attribution", err);
        return hunks;
      }
      const colours = buildColourMap(awareness);
      const colourOf = (name: string): string => colours.get(name) ?? NEUTRAL_COLLAB_COLOR;
      // clientID → name from live awareness; authoritative over the name-keyed
      // `users` map for connected editors (see buildAwarenessNameMap).
      const awarenessNames = buildAwarenessNameMap(awareness);

      let liveCursor = 0;
      let delCursor = 0;
      const w: SideState = { inAtomDepth: 0, atomOrd: 0, enteredViaRemoved: false };
      const c: SideState = { inAtomDepth: 0, atomOrd: 0, enteredViaRemoved: false };
      /** Atoms entered specifically within REMOVED parts (→ deleted-atom ordinals). */
      let delAtomOrd = 0;

      const authorByIndex = new Map<number, HunkAuthor>();

      const applyTag = (state: SideState, token: string, removedSide: boolean): void => {
        if (state.inAtomDepth === 0) {
          if (isFaqOpen(token)) {
            state.inAtomDepth = 1;
            state.atomOrd += 1;
            state.enteredViaRemoved = removedSide;
            if (removedSide) delAtomOrd += 1;
          }
        } else if (isDivOpen(token)) {
          state.inAtomDepth += 1;
        } else if (isDivClose(token)) {
          state.inAtomDepth -= 1;
        }
      };

      // getUserByClientId is typed `any`; coerce to a clean string | null.
      const nameByClientId = (client: number): string | null => {
        // Awareness (keyed by the live clientID) is authoritative for connected
        // editors; PermanentUserData is the fallback for authors who have left.
        const live = awarenessNames.get(client);
        if (live) return live;
        const name: unknown = pud.getUserByClientId(client);
        return typeof name === "string" ? name : null;
      };

      const resolveLiveAuthors = (count: number, into: Array<string | null>): void => {
        for (let k = 0; k < count; k++) {
          const ch = scan.liveChars[liveCursor + k];
          into.push(ch ? nameByClientId(ch.client) : null);
        }
        liveCursor += count;
      };

      const resolveDelAuthors = (count: number, into: Array<string | null>): void => {
        for (let k = 0; k < count; k++) {
          const ch = scan.delChars[delCursor + k];
          into.push(ch ? pud.getUserByDeletedId(ch.id) : null);
        }
        delCursor += count;
      };

      const atomAuthor = (atoms: AtomEl[], ord: number, deleted: boolean): string | null => {
        const el = atoms[ord - 1];
        if (!el) return null;
        // A live atom's hunks come from `items` attribute rewrites, so the
        // attribute's last writer — not the widget's original inserter — is the
        // person who made the change.
        return deleted ? pud.getUserByDeletedId(el.id) : nameByClientId(el.attrClient ?? el.client);
      };

      parts.forEach((part: DiffPart, index: number) => {
        const removed = !!part.removed;
        const added = !!part.added;
        const state = removed ? c : w;
        // Accumulate this part's author candidates (only meaningful for hunks).
        const names: Array<string | null> = [];

        // The Yjs char cursors count DECODED characters, but the diff tokenizer
        // FRAGMENTS an entity across tokens (`&amp;` → "&", "amp", ";"), so a token
        // is not independently decodable. Buffer consecutive text tokens into a run
        // (broken only by tags, which alone change atom depth) and decode the whole
        // run before advancing the cursor — otherwise every entity overshoots by
        // its expansion (+4 for `&amp;`) and strands blame for the rest of the doc.
        let textRun = "";
        const flushTextRun = (): void => {
          if (textRun === "") return;
          const len = decodedTextLen(textRun);
          textRun = "";
          const inAtom = state.inAtomDepth > 0;
          if (added) {
            if (inAtom) names.push(atomAuthor(scan.liveAtoms, state.atomOrd, false));
            else resolveLiveAuthors(len, names);
          } else if (removed) {
            if (inAtom) {
              // Two distinct removals land here: a WHOLE deleted widget (wrapper
              // itself was in a removed part → tombstoned element, deleted-atom
              // ordinals) vs a per-item delete/edit inside a LIVE widget (wrapper
              // unchanged → the change is an `items` attribute rewrite on the
              // live element; scan.delAtoms has no entry for it). For the latter,
              // attribute to the live atom: the unchanged wrapper advanced BOTH
              // sides' ordinals, so `w.atomOrd` indexes scan.liveAtoms here.
              if (state.enteredViaRemoved) names.push(atomAuthor(scan.delAtoms, delAtomOrd, true));
              else names.push(atomAuthor(scan.liveAtoms, w.atomOrd, false));
            } else resolveDelAuthors(len, names);
          } else {
            // Unchanged: advance the live cursor so subsequent `added` parts align;
            // unchanged text is never deleted, so the del cursor is untouched.
            if (!inAtom) liveCursor += len;
          }
        };

        for (const token of part.value) {
          if (isTag(token)) {
            // Flush the buffered text BEFORE the tag toggles atom depth, so it is
            // attributed under the depth that was active while it was emitted.
            flushTextRun();
            // A tag tracks atom nesting on the side(s) it appears on: added tags on
            // the working side, removed on the committed side, unchanged on BOTH.
            if (added) {
              applyTag(w, token, false);
            } else if (removed) {
              applyTag(c, token, true);
            } else {
              applyTag(w, token, false);
              applyTag(c, token, false);
            }
            continue;
          }
          textRun += token;
        }
        flushTextRun();

        if ((added || removed) && names.some((n) => n)) {
          const name = dominant(names);
          if (name) authorByIndex.set(index, { name, color: colourOf(name) });
        }
      });

      return hunks.map((h) => {
        const author = authorByIndex.get(h.index);
        return author ? { ...h, author } : h;
      });
    },
  };
}
