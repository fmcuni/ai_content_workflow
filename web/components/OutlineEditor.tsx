"use client";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import type { Outline } from "@/lib/types";

export function OutlineEditor({
  outline, onChange,
}: { outline: Outline; onChange: (o: Outline) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <label className="text-xs text-neutral-500">H1</label>
        <Input value={outline.h1} onChange={(e) => onChange({ ...outline, h1: e.target.value })} />
      </div>
      <div>
        <label className="text-xs text-neutral-500">Meta description hint</label>
        <Input value={outline.meta_description_hint}
               onChange={(e) => onChange({ ...outline, meta_description_hint: e.target.value })} />
      </div>
      {outline.sections.map((s, i) => (
        <div key={i} className="border p-3 rounded bg-neutral-50 space-y-2">
          <div className="flex gap-2">
            <span className="text-xs text-neutral-500">H{s.heading_level}</span>
            <Input value={s.heading_text}
                   onChange={(e) => {
                     const next = [...outline.sections]; next[i] = { ...s, heading_text: e.target.value };
                     onChange({ ...outline, sections: next });
                   }} />
            <select className="border rounded p-1 text-xs" value={s.action}
                    onChange={(e) => {
                      const next = [...outline.sections]; next[i] = { ...s, action: e.target.value as typeof s.action };
                      onChange({ ...outline, sections: next });
                    }}>
              {["keep","update","add","remove","reorder"].map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <Textarea value={s.key_points.join("\n")}
                    rows={3}
                    onChange={(e) => {
                      const next = [...outline.sections];
                      next[i] = { ...s, key_points: e.target.value.split("\n").filter(Boolean) };
                      onChange({ ...outline, sections: next });
                    }} />
        </div>
      ))}
    </div>
  );
}
