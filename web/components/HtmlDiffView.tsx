import { diffWords } from "diff";

export function HtmlDiffView({ original, updated }: { original: string; updated: string }) {
  const parts = diffWords(original, updated);
  return (
    <div className="text-sm leading-6 whitespace-pre-wrap font-mono">
      {parts.map((p, i) => (
        <span
          key={i}
          className={
            p.added ? "bg-emerald-100" : p.removed ? "bg-rose-100 line-through" : ""
          }
        >
          {p.value}
        </span>
      ))}
    </div>
  );
}
