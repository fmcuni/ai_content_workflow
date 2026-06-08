"use client";
import type { Dispatch, SetStateAction } from "react";

import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WordPressMetaForm } from "@/components/WordPressMetaForm";
import { CommentsSidebar } from "@/components/CommentsSidebar";
import type { Hitl2Comment, Hitl2Request } from "@/lib/types";

interface EditorRailProps {
  tab: "wp" | "comments";
  onTabChange: (t: "wp" | "comments") => void;
  form: Hitl2Request;
  onFormChange: Dispatch<SetStateAction<Hitl2Request>>;
  existingAuthorName: string | null;
  existingCategoryName: string | null;
  comments: Hitl2Comment[];
  focusedCommentId: string | null;
  onCommentChange: (id: string, body: string) => void;
  onCommentDelete: (id: string) => void;
  onCommentFocus: (id: string) => void;
  onCommentApply: (id: string) => void;
  applyingCommentId: string | null;
}

/**
 * The right rail shared by /hitl2 and /edit (NOT /regenerate): a WP metadata
 * ↔ Comments tab switcher wrapping WordPressMetaForm and CommentsSidebar.
 */
export function EditorRail({
  tab,
  onTabChange,
  form,
  onFormChange,
  existingAuthorName,
  existingCategoryName,
  comments,
  focusedCommentId,
  onCommentChange,
  onCommentDelete,
  onCommentFocus,
  onCommentApply,
  applyingCommentId,
}: EditorRailProps) {
  return (
    <aside className="lg:sticky lg:top-6 self-start lg:max-h-[calc(100vh-6.25rem)] lg:overflow-y-auto">
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as "wp" | "comments")}>
        <TabsList className="border-b border-rule">
          <TabsTrigger value="wp">WP metadata</TabsTrigger>
          <TabsTrigger value="comments">
            Comments
            {comments.length > 0 && <span className="ml-1 text-accent">({comments.length})</span>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="wp" className="pt-4">
          <Card variant="editorial" className="px-5 py-5">
            <WordPressMetaForm
              form={form}
              onChange={onFormChange}
              existingAuthorName={existingAuthorName}
              existingCategoryName={existingCategoryName}
            />
          </Card>
        </TabsContent>
        <TabsContent value="comments" className="pt-4">
          <CommentsSidebar
            comments={comments}
            focusedId={focusedCommentId}
            onChange={onCommentChange}
            onDelete={onCommentDelete}
            onFocus={onCommentFocus}
            onApply={onCommentApply}
            applyingId={applyingCommentId}
          />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
