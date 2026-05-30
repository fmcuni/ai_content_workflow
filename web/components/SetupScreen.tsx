"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { setupApi } from "@/lib/api";
import type { SetupRequest, SetupVerifyResult } from "@/lib/types";

const PG_PREFIXES = ["postgresql://", "postgresql+asyncpg://"];

function pgLooksValid(url: string): boolean {
  return PG_PREFIXES.some((p) => url.startsWith(p));
}

type WpFields = {
  wp_base_url: string;
  wp_target: "staging" | "production" | "";
  wp_username: string;
  wp_app_password: string;
};

function buildRequest(
  geminiKey: string,
  postgresUrl: string,
  wpEnabled: boolean,
  wp: WpFields,
): SetupRequest {
  const body: SetupRequest = {
    gemini_api_key: geminiKey.trim(),
    postgres_url: postgresUrl.trim(),
  };
  if (wpEnabled) {
    if (wp.wp_base_url.trim()) body.wp_base_url = wp.wp_base_url.trim();
    if (wp.wp_target) body.wp_target = wp.wp_target;
    if (wp.wp_username.trim()) body.wp_username = wp.wp_username.trim();
    if (wp.wp_app_password) body.wp_app_password = wp.wp_app_password;
  }
  return body;
}

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li className="flex items-center justify-between font-mono text-[12px]">
      <span className="text-ink-soft">{label}</span>
      <span className={ok ? "text-emerald-700" : "text-accent-deep"}>
        {ok ? "✓ reachable" : "✗ failed"}
      </span>
    </li>
  );
}

export function SetupScreen() {
  const queryClient = useQueryClient();

  const [geminiKey, setGeminiKey] = useState("");
  const [postgresUrl, setPostgresUrl] = useState("");
  const [wpEnabled, setWpEnabled] = useState(false);
  const [wp, setWp] = useState<WpFields>({
    wp_base_url: "",
    wp_target: "",
    wp_username: "",
    wp_app_password: "",
  });
  const [checks, setChecks] = useState<SetupVerifyResult | null>(null);

  const canSubmit = geminiKey.trim().length > 0 && pgLooksValid(postgresUrl.trim());

  const verifyMutation = useMutation({
    mutationFn: () => setupApi.verify(buildRequest(geminiKey, postgresUrl, wpEnabled, wp)),
    onSuccess: (result) => {
      setChecks(result);
      if (result.postgres && result.gemini) {
        toast.success("Both connections look good — you can save now.");
      } else {
        toast.error("One or more connections failed. Check the details below.");
      }
    },
    onError: (e: Error) => toast.error(`Couldn't test the connection — ${e.message}`),
  });

  const configureMutation = useMutation({
    mutationFn: () => setupApi.configure(buildRequest(geminiKey, postgresUrl, wpEnabled, wp)),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success("Setup complete — starting the content desk.");
        queryClient.invalidateQueries({ queryKey: ["setup-status"] });
      } else {
        setChecks(result.checks);
        toast.error("Credentials could not be verified. Nothing was saved.");
      }
    },
    onError: (e: Error) => toast.error(`Setup failed — ${e.message}`),
  });

  const busy = verifyMutation.isPending || configureMutation.isPending;

  return (
    <div className="min-h-screen bg-paper text-ink flex items-center justify-center px-5 py-12">
      <div className="w-full max-w-[560px]">
        <p className="kicker">Bowtie Content Desk · First-run setup</p>
        <h1
          className="font-display text-[32px] leading-tight mt-1"
          style={{ fontVariationSettings: '"opsz" 40, "SOFT" 70' }}
        >
          Connect your services
        </h1>
        <p className="font-sans text-[13px] text-ink-faint mt-2">
          These are stored locally on this machine only. You can change them later.
        </p>

        <form
          className="mt-8 space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && !busy) configureMutation.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="gemini_api_key">Gemini API key</Label>
            <Input
              id="gemini_api_key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="AIza…"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="postgres_url">Supabase / Postgres URL</Label>
            <Input
              id="postgres_url"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="postgresql+asyncpg://user:password@host:5432/postgres"
              value={postgresUrl}
              onChange={(e) => setPostgresUrl(e.target.value)}
            />
            {postgresUrl.trim().length > 0 && !pgLooksValid(postgresUrl.trim()) ? (
              <p className="font-mono text-[11px] text-accent-deep">
                Must start with postgresql:// or postgresql+asyncpg://
              </p>
            ) : null}
          </div>

          <div className="border-t border-rule pt-5">
            <label className="flex items-center justify-between cursor-pointer">
              <span>
                <span className="font-sans text-[13px] text-ink font-medium">
                  Configure WordPress publishing now
                </span>
                <span className="block font-sans text-[12px] text-ink-faint">
                  Optional — you can add this later.
                </span>
              </span>
              <Switch
                checked={wpEnabled}
                onCheckedChange={(v: boolean) => setWpEnabled(v)}
                aria-label="Configure WordPress publishing now"
              />
            </label>

            {wpEnabled ? (
              <div className="mt-5 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="wp_base_url">WordPress base URL</Label>
                  <Input
                    id="wp_base_url"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://example.com"
                    value={wp.wp_base_url}
                    onChange={(e) => setWp({ ...wp, wp_base_url: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wp_target">Target environment</Label>
                  <Select
                    value={wp.wp_target}
                    onValueChange={(v) =>
                      setWp({ ...wp, wp_target: v as WpFields["wp_target"] })
                    }
                  >
                    <SelectTrigger id="wp_target">
                      <SelectValue placeholder="Choose a target" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="staging">Staging</SelectItem>
                      <SelectItem value="production">Production</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wp_username">WordPress username</Label>
                  <Input
                    id="wp_username"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={wp.wp_username}
                    onChange={(e) => setWp({ ...wp, wp_username: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wp_app_password">Application password</Label>
                  <Input
                    id="wp_app_password"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={wp.wp_app_password}
                    onChange={(e) => setWp({ ...wp, wp_app_password: e.target.value })}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {checks ? (
            <ul className="border border-rule rounded-[2px] bg-paper-deep/40 px-4 py-3 space-y-1.5">
              <CheckRow label="Postgres" ok={checks.postgres} />
              <CheckRow label="Gemini" ok={checks.gemini} />
            </ul>
          ) : null}

          <div className="flex items-center gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              disabled={!canSubmit || busy}
              onClick={() => verifyMutation.mutate()}
            >
              {verifyMutation.isPending ? "Testing…" : "Test connection"}
            </Button>
            <Button type="submit" disabled={!canSubmit || busy}>
              {configureMutation.isPending ? "Saving…" : "Save & continue"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
