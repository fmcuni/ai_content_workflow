"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { SectionHead } from "@/components/SectionHead";
import { Button } from "@/components/ui/button";
import { ReadinessBadge } from "@/components/publish-targets/ReadinessPanel";
import { TargetDrawer } from "@/components/publish-targets/TargetDrawer";
import { publishTargetsApi } from "@/lib/api";
import type { PublishTarget } from "@/lib/types";
import { useRole } from "@/lib/use-role";

type DrawerMode = null | { kind: "create" } | { kind: "edit"; target: PublishTarget };

export default function PublishTargetsPage() {
  // CMS-destination config is admin-only (server-authoritative). Reuse the
  // personas-management capability since targets bind to voices.
  const { can, isLoading: roleLoading } = useRole();
  const canManage = can("manage_personas");
  const [showArchived, setShowArchived] = useState(false);
  const [drawer, setDrawer] = useState<DrawerMode>(null);

  const targets = useQuery({
    queryKey: ["publish-targets", showArchived],
    queryFn: () => publishTargetsApi.list(showArchived),
  });

  if (!roleLoading && !canManage) {
    return (
      <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
        <SectionHead kicker="Settings" hed="Publish Targets" />
        <p className="text-accent-deep text-[13px]">
          You need admin access to manage publish targets.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 space-y-8">
      <SectionHead
        kicker="Settings · CMS"
        hed="Publish Targets"
        dek="The CMS destinations a voice can publish to. Config only — base URL and credentials live in the environment under each target's auth_ref prefix."
        actions={
          canManage ? (
            <Button variant="primary" size="sm" onClick={() => setDrawer({ kind: "create" })}>
              + New target
            </Button>
          ) : undefined
        }
      />

      {targets.isLoading && <p className="text-ink-faint">Loading targets…</p>}
      {targets.isError && (
        <p className="text-accent-deep text-[13px]">Failed to load publish targets.</p>
      )}

      {targets.data && (
        <div className="border border-rule rounded-[2px] overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule bg-paper-soft text-left">
                <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Name</th>
                <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Kind</th>
                <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Auth ref</th>
                <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Status</th>
                <th className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Secrets</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {targets.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-ink-faint">
                    No publish targets yet.
                  </td>
                </tr>
              )}
              {targets.data.map((t) => (
                <tr
                  key={t.publish_target_id}
                  className="border-b border-rule last:border-0 hover:bg-paper-soft/60"
                >
                  <td className="px-4 py-2.5">
                    <span className={t.is_archived ? "text-ink-faint line-through" : "text-ink"}>
                      {t.name}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-soft">{t.kind}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-soft">{t.auth_ref}</td>
                  <td className="px-4 py-2.5 text-ink-soft">{t.status}</td>
                  <td className="px-4 py-2.5">
                    {t.is_archived ? (
                      <span className="text-[11px] text-ink-faint">archived</span>
                    ) : (
                      <ReadinessBadge targetId={t.publish_target_id} />
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDrawer({ kind: "edit", target: t })}
                      >
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <label className="text-[12px] text-ink-faint inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        show archived
      </label>

      {drawer && canManage && (
        <TargetDrawer
          mode={drawer}
          onClose={() => setDrawer(null)}
          onSaved={() => setDrawer(null)}
        />
      )}
    </div>
  );
}
