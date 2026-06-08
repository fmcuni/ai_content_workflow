"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReadinessPanel } from "@/components/publish-targets/ReadinessPanel";
import { publishTargetsApi } from "@/lib/api";
import type { PublishTarget } from "@/lib/types";

type Mode = { kind: "create" } | { kind: "edit"; target: PublishTarget };

interface TargetDrawerProps {
  mode: Mode;
  onClose: () => void;
  onSaved: () => void;
}

const AUTH_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The env vars an operator must provision for a target's auth_ref prefix. */
function secretNames(authRef: string): string[] {
  const ref = authRef || "{AUTH_REF}";
  return [`${ref}_BASE_URL`, `${ref}_USERNAME`, `${ref}_APP_PASSWORD`];
}

export function TargetDrawer({ mode, onClose, onSaved }: TargetDrawerProps) {
  const isEdit = mode.kind === "edit";
  const qc = useQueryClient();
  const [name, setName] = useState(isEdit ? mode.target.name : "");
  const [authRef, setAuthRef] = useState(isEdit ? mode.target.auth_ref : "");
  const [status, setStatus] = useState<"active" | "inactive">(
    isEdit ? (mode.target.status === "inactive" ? "inactive" : "active") : "active",
  );

  // Assigned-voice count powers the archive confirmation warning.
  const usage = useQuery({
    queryKey: ["publish-target-usage", isEdit ? mode.target.publish_target_id : null],
    queryFn: () => publishTargetsApi.usage(mode.kind === "edit" ? mode.target.publish_target_id : ""),
    enabled: isEdit,
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ["publish-targets"] });
  }

  const save = useMutation({
    mutationFn: async () => {
      if (mode.kind === "create") {
        return publishTargetsApi.create({ name, auth_ref: authRef, status });
      }
      return publishTargetsApi.update(mode.target.publish_target_id, { name, status });
    },
    onSuccess: () => {
      toast.success(isEdit ? "Target updated" : "Target created");
      invalidate();
      onSaved();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const archive = useMutation({
    mutationFn: async () => {
      if (mode.kind !== "edit") return;
      return mode.target.is_archived
        ? publishTargetsApi.restore(mode.target.publish_target_id)
        : publishTargetsApi.archive(mode.target.publish_target_id);
    },
    onSuccess: () => {
      toast.success(mode.kind === "edit" && mode.target.is_archived ? "Target restored" : "Target archived");
      invalidate();
      onSaved();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Action failed"),
  });

  const nameValid = name.trim().length >= 1 && name.length <= 128;
  const authRefValid = isEdit || (AUTH_REF_RE.test(authRef) && authRef.length <= 64);
  const canSave = nameValid && authRefValid && !save.isPending;

  const assignedCount = usage.data?.assigned_voice_count ?? 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit publish target" : "New publish target"}</DialogTitle>
          <DialogDescription>
            CMS destination config only. Base URL + credentials live in the
            environment under the auth_ref prefix — provision them separately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pt-name">Display name</Label>
            <Input
              id="pt-name"
              value={name}
              maxLength={128}
              placeholder="e.g. VHIS101 WordPress"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pt-auth-ref">Auth ref (env prefix)</Label>
            <Input
              id="pt-auth-ref"
              value={authRef}
              maxLength={64}
              disabled={isEdit}
              placeholder="e.g. VHIS101_WP"
              onChange={(e) => setAuthRef(e.target.value)}
              aria-invalid={!authRefValid}
            />
            {isEdit ? (
              <p className="text-[11px] text-ink-faint">
                Locked — changing which secrets a live target reads is not allowed here.
              </p>
            ) : (
              <p className="text-[11px] text-ink-faint">
                Letters, digits, underscore; starts with a letter/underscore. Conventionally uppercase.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pt-status">Status</Label>
            <select
              id="pt-status"
              value={status}
              onChange={(e) => setStatus(e.target.value === "inactive" ? "inactive" : "active")}
              className="w-full rounded-[2px] border border-rule bg-paper px-2.5 py-1.5 text-[13px]"
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </div>

          {/* Secrets the operator must provision for this target to publish. */}
          <div className="rounded-[2px] border border-rule bg-paper-soft p-3 space-y-2">
            <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint">
              Required secrets
            </p>
            <ul className="space-y-0.5 font-mono text-[11px] text-ink-soft">
              {secretNames(authRef).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <p className="text-[11px] text-ink-faint">
              Set via <code>wrangler secret put</code> (prod) or <code>.env.local</code> (dev).
            </p>
            {isEdit ? <ReadinessPanel targetId={mode.target.publish_target_id} /> : null}
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between gap-3">
          {isEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={archive.isPending}
              onClick={() => {
                if (mode.target.is_archived) {
                  archive.mutate();
                  return;
                }
                const warn =
                  assignedCount > 0
                    ? `Archive "${mode.target.name}"? ${assignedCount} voice(s) are assigned and will fall back to the default WordPress until reassigned.`
                    : `Archive "${mode.target.name}"?`;
                if (window.confirm(warn)) archive.mutate();
              }}
            >
              {mode.target.is_archived ? "Restore" : "Archive"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!canSave}
              onClick={() => save.mutate()}
            >
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
