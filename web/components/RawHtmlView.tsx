"use client";
import { toast } from "sonner";

interface RawHtmlViewProps {
  /** The HTML body to display and copy. */
  html: string;
}

/**
 * Read-only raw HTML body with a copy-to-clipboard control. Shared by the
 * HITL_2 review gate and the filed-run edit page so both render the body
 * identically.
 */
export function RawHtmlView({ html }: RawHtmlViewProps) {
  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <p className="kicker">Raw HTML body</p>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(html);
            toast.success("Copied raw HTML");
          }}
          className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
        >
          ⧉ Copy
        </button>
      </div>
      <pre className="border border-rule bg-paper rounded p-3 text-[12px] leading-relaxed whitespace-pre-wrap break-words font-mono text-ink overflow-x-auto max-h-[70vh]">
        {html || "(empty)"}
      </pre>
    </>
  );
}
