"use client";
import * as React from "react";

// Minimal Markdown renderer for model "thought" text.
//
// Gemini emits standard Markdown in its reasoning summaries — **bold** section
// titles, `inline code`, *italics*, # headings and "- " bullets. The thinking
// stream is the only surface in the app that shows this raw text, so rather than
// pull in a full Markdown dependency (react-markdown et al.) we handle the small,
// well-bounded subset the model actually produces. Anything we don't recognise
// falls through as plain text, so unknown syntax degrades gracefully instead of
// rendering as stray asterisks.

// Inline tokens, matched in priority order so `**bold**` is never split by the
// single-asterisk *italic* rule. Underscore-italics (`_x_`) are deliberately NOT
// supported: the model's reasoning is full of snake_case identifiers like
// `gap_analysis.update_plan`, and treating `_` as emphasis would mangle them.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={key} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={key}
          className="font-mono text-[12px] bg-rule/40 rounded px-1 py-0.5 text-ink"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

interface ThoughtMarkdownProps {
  text: string;
  className?: string;
}

export function ThoughtMarkdown({ text, className }: ThoughtMarkdownProps) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let bullets: string[] = [];

  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={key} className="list-disc pl-5 my-1.5 space-y-1">
        {items.map((b, j) => (
          <li key={j}>{renderInline(b, `${key}-${j}`)}</li>
        ))}
      </ul>,
    );
  };

  lines.forEach((line, i) => {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      return;
    }
    flushBullets(`ul-${i}`);

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <p key={i} className="font-semibold text-ink mt-3 first:mt-0 mb-1">
          {renderInline(heading[2], `h-${i}`)}
        </p>,
      );
      return;
    }

    if (line.trim() === "") return; // blank line → paragraph spacing handles it

    blocks.push(
      <p key={i} className="mb-2 last:mb-0">
        {renderInline(line, `p-${i}`)}
      </p>,
    );
  });
  flushBullets(`ul-${lines.length}`);

  return <div className={className}>{blocks}</div>;
}
