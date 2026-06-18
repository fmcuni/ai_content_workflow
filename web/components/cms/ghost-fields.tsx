"use client";

import { useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/SearchableSelect";
import { uploadMedia } from "@/lib/api";
import type { Hitl2Request, PublishTargetKind } from "@/lib/types";
import { useGhostAuthors, useGhostTags } from "@/lib/use-ghost-options";

/** Single primary-author picker sourced live from the run's Ghost target —
 * a searchable combobox (parity with WordPress's author picker). Stores
 * ghost_author_ids as a one-element array (or [] = Ghost auto-assigns). */
export function CmsGhostAuthorSelect({
  runId,
  value,
  onChange,
}: {
  runId?: string;
  value: string[] | null;
  onChange: (v: string[]) => void;
}) {
  const q = useGhostAuthors(runId);
  const authors = q.data ?? [];
  const current = (value ?? [])[0] ?? null;
  return (
    <SearchableSelect
      options={authors}
      value={current}
      onChange={(next) => onChange(next != null ? [String(next)] : [])}
      loading={q.isLoading}
      placeholder="Search author by name…"
    />
  );
}

/** Tag chips + typeahead. Suggests existing Ghost tags (datalist) but allows
 * new names — Ghost matches-or-auto-creates by name on publish. */
export function CmsGhostTagPicker({
  runId,
  value,
  onChange,
}: {
  runId?: string;
  value: string[] | null;
  onChange: (v: string[]) => void;
}) {
  const q = useGhostTags(runId);
  const existing = q.data ?? [];
  const tags = value ?? [];
  const [draft, setDraft] = useState("");

  const add = (name: string) => {
    const n = name.trim();
    setDraft("");
    if (n === "" || tags.includes(n)) return;
    onChange([...tags, n]);
  };
  const remove = (name: string) => onChange(tags.filter((t) => t !== name));

  return (
    <div className="space-y-1.5">
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full border border-rule bg-paper-soft px-2 py-0.5 text-[12px]"
            >
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                className="text-ink-faint hover:text-ink"
                onClick={() => remove(t)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Input
        list="ghost-tag-suggestions"
        value={draft}
        placeholder="Type a tag, press Enter…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
      />
      <datalist id="ghost-tag-suggestions">
        {existing.map((t) => (
          <option key={t.slug} value={t.name} />
        ))}
      </datalist>
    </div>
  );
}

/**
 * Kind-aware feature/featured image control. Uploads to the run's CMS media
 * store and writes the result back: Ghost → feature_image_url; WordPress →
 * wp_featured_media_id (+ url for preview). A manual field stays as an override.
 */
export function CmsFeatureImageField({
  runId,
  kind,
  valueUrl,
  valueMediaId,
  onChange,
}: {
  runId?: string;
  kind: PublishTargetKind;
  valueUrl: string | null;
  valueMediaId: number | null;
  onChange: (patch: Partial<Hitl2Request>) => void;
}) {
  const isGhost = kind === "ghost";
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const r = await uploadMedia(file, { runId });
      if (isGhost) {
        onChange({ feature_image_url: r.url });
      } else {
        onChange({ wp_featured_media_id: r.id, feature_image_url: r.url });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {valueUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external CMS URL
        <img
          src={valueUrl}
          alt="Feature image preview"
          className="h-20 w-auto rounded-md border border-rule object-cover"
        />
      ) : null}
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[12.5px] hover:border-accent disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Upload image"}
        </button>
        {isGhost ? (
          <Input
            value={valueUrl ?? ""}
            placeholder="or paste an image URL"
            onChange={(e) => onChange({ feature_image_url: e.target.value || null })}
          />
        ) : (
          <Input
            type="number"
            value={valueMediaId ?? ""}
            placeholder="media id"
            onChange={(e) =>
              onChange({
                wp_featured_media_id: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
          />
        )}
      </div>
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
