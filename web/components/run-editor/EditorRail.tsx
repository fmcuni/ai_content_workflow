"use client";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Sparkles } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WordPressMetaForm } from "@/components/WordPressMetaForm";
import { CommentsSidebar } from "@/components/CommentsSidebar";
import { NotesToAi } from "@/components/run-editor/NotesToAi";
import type { Hitl2Comment, Hitl2Request } from "@/lib/types";

export type EditorRailTab = "wp" | "comments" | "review";

interface EditorRailProps {
  tab: EditorRailTab;
  onTabChange: (t: EditorRailTab) => void;
  form: Hitl2Request;
  onFormChange: Dispatch<SetStateAction<Hitl2Request>>;
  /** Scopes the WP metadata pickers to this run's CMS target (per-voice). */
  runId: string;
  existingAuthorName: string | null;
  existingCategoryName: string | null;
  comments: Hitl2Comment[];
  focusedCommentId: string | null;
  onCommentChange: (id: string, body: string) => void;
  onCommentDelete: (id: string) => void;
  onCommentFocus: (id: string) => void;
  /** Whole-article change note value + setter. */
  notesValue: string;
  onNotesChange: (v: string) => void;
  /** Fire the single inline AI edit (highlight comments take priority over the note). */
  onRequestEdit: () => void;
  /** The AI edit is in flight — disables the request button. */
  requesting: boolean;
  /** False when there is neither a highlight comment nor a note to act on. */
  requestEnabled: boolean;
  /** Human review-thread panel (separate pipeline from "AI to edit"). */
  reviewPanel: ReactNode;
  /** Count badge for the Review tab (open + resolved). */
  reviewCount: number;
}

/**
 * The right rail shared by /hitl2 and /edit: a WP metadata ↔ "AI to edit" tab
 * switcher. The "AI to edit" tab holds the highlight comments, a whole-article
 * change note, and one "Request AI to edit" button that sends whichever input is
 * present (comments first, else the note) to the inline editor agent.
 */
export function EditorRail({
  tab,
  onTabChange,
  form,
  onFormChange,
  runId,
  existingAuthorName,
  existingCategoryName,
  comments,
  focusedCommentId,
  onCommentChange,
  onCommentDelete,
  onCommentFocus,
  notesValue,
  onNotesChange,
  onRequestEdit,
  requesting,
  requestEnabled,
  reviewPanel,
  reviewCount,
}: EditorRailProps) {
  const hasComments = comments.some((c) => c.body.trim().length > 0);

  return (
    <aside className="lg:sticky lg:top-0 self-start lg:max-h-[calc(100vh-4rem)] lg:overflow-y-auto">
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as EditorRailTab)}>
        <TabsList className="border-b border-rule">
          <TabsTrigger value="wp">WP metadata</TabsTrigger>
          <TabsTrigger value="comments">
            AI to edit
            {comments.length > 0 && <span className="ml-1 text-accent">({comments.length})</span>}
          </TabsTrigger>
          <TabsTrigger value="review">
            Review
            {reviewCount > 0 && <span className="ml-1 text-accent">({reviewCount})</span>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="wp" className="pt-4">
          <Card variant="editorial" className="px-5 py-5">
            <WordPressMetaForm
              form={form}
              onChange={onFormChange}
              runId={runId}
              existingAuthorName={existingAuthorName}
              existingCategoryName={existingCategoryName}
            />
          </Card>
        </TabsContent>
        <TabsContent value="comments" className="pt-4">
          {/* Mode 1 — highlighted comments (priority). When present, the AI acts
              on these and the whole-article note below is ignored. */}
          <div className="flex items-baseline justify-between mb-3">
            <p className="kicker">Highlighted comments</p>
            <span
              className={`font-mono text-[10px] uppercase tracking-wider ${
                hasComments ? "text-accent" : "text-ink-faint"
              }`}
            >
              {hasComments ? "Active" : "None"}
            </span>
          </div>
          <CommentsSidebar
            comments={comments}
            focusedId={focusedCommentId}
            onChange={onCommentChange}
            onDelete={onCommentDelete}
            onFocus={onCommentFocus}
          />

          {/* Mode 2 — whole-article change (fallback). Dimmed while comments
              exist, so the priority rule is visible, not just documented. */}
          <div
            className={`mt-6 border-t border-rule pt-5 transition-opacity ${
              hasComments ? "opacity-45" : ""
            }`}
          >
            <div className="flex items-baseline justify-between mb-2">
              <p className="kicker">Whole article change</p>
              {hasComments && (
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  Ignored
                </span>
              )}
            </div>
            <NotesToAi
              value={notesValue}
              onChange={onNotesChange}
              label=""
              placeholder="Describe a change for the whole article — used when there are no highlighted comments."
            />
          </div>

          {/* Primary action — sticky to the bottom of the rail's scroll area so
              it stays reachable however long the comment list grows. */}
          <div className="sticky bottom-0 mt-5 bg-paper/95 backdrop-blur border-t border-rule pt-3 pb-1">
            <button
              type="button"
              disabled={!requestEnabled || requesting}
              onClick={onRequestEdit}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-ink bg-paper px-3 py-2 font-mono text-[12px] uppercase tracking-wider text-ink hover:bg-ink hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-paper disabled:hover:text-ink"
              title={
                requestEnabled
                  ? "Let AI revise the article from your comments or whole-article change."
                  : "Highlight text and comment, or write a whole-article change first."
              }
            >
              <Sparkles className="h-3.5 w-3.5" />
              {requesting ? "Requesting…" : "Request AI to edit"}
            </button>
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-faint text-center mt-2">
              {hasComments
                ? "Acts on highlighted comments"
                : notesValue.trim().length > 0
                ? "Acts on the whole-article change"
                : "Highlight text or describe a change"}
            </p>
          </div>
        </TabsContent>
        <TabsContent value="review" className="pt-4">
          {/* Human-only review threads — a SEPARATE pipeline from "AI to edit".
              These are never dispatched to the AI; they are for people to
              comment, reply, and resolve. */}
          <div className="mb-3 flex items-baseline justify-between">
            <p className="kicker">Review notes</p>
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              Human only
            </span>
          </div>
          {reviewPanel}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
