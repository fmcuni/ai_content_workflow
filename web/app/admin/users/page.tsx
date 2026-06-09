"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SectionHead } from "@/components/SectionHead";
import { adminUsersApi, type AdminUserDetail } from "@/lib/api";
import { ROLES } from "@/lib/roles";
import type { UserRole } from "@/lib/types";
import { useRole } from "@/lib/use-role";

const SELECT_CLASSES =
  "h-9 w-[150px] bg-transparent text-[13px] text-ink border-0 border-b border-rule rounded-none px-0 py-1.5 outline-none focus-visible:border-b-2 focus-visible:border-accent appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

const ACTION_CLASSES =
  "font-mono text-[10px] tracking-[0.12em] uppercase text-ink-faint hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed";

const USERS_QUERY_KEY = ["admin", "users"] as const;

/** A single user row: identity + status badge + role select + per-row actions. */
function UserRow({ user }: { user: AdminUserDetail }) {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    // The current operator may have changed their own role — refresh /me.
    qc.invalidateQueries({ queryKey: ["me"] });
  };

  const setRole = useMutation({
    mutationFn: (role: UserRole) => adminUsersApi.setRole(user.id, role),
    onSuccess: (updated) => {
      toast.success(`${updated.email} is now ${updated.role}`);
      refresh();
    },
    onError: (e: Error) => toast.error(`Couldn't update role — ${e.message}`),
  });

  const isDisabled = user.status === "disabled";

  const toggleStatus = useMutation({
    mutationFn: () => (isDisabled ? adminUsersApi.enable(user.id) : adminUsersApi.disable(user.id)),
    onSuccess: (updated) => {
      toast.success(
        `${updated.email} is now ${updated.status === "disabled" ? "disabled" : "active"}`,
      );
      refresh();
    },
    onError: (e: Error) => toast.error(`Couldn't change status — ${e.message}`),
  });

  const remove = useMutation({
    mutationFn: () => adminUsersApi.remove(user.id),
    onSuccess: () => {
      toast.success(`${user.email} deleted`);
      refresh();
    },
    onError: (e: Error) => toast.error(`Couldn't delete user — ${e.message}`),
  });

  const resendInvite = useMutation({
    mutationFn: () => adminUsersApi.resendInvite(user.id),
    onSuccess: () => toast.success(`Invite re-sent to ${user.email}`),
    onError: (e: Error) => toast.error(`Couldn't resend invite — ${e.message}`),
  });

  const revokeSessions = useMutation({
    mutationFn: () => adminUsersApi.revokeSessions(user.id),
    onSuccess: () => toast.success(`Signed ${user.email} out of all sessions`),
    onError: (e: Error) => toast.error(`Couldn't revoke sessions — ${e.message}`),
  });

  const busy =
    setRole.isPending ||
    toggleStatus.isPending ||
    remove.isPending ||
    resendInvite.isPending ||
    revokeSessions.isPending;

  return (
    <li className="grid grid-cols-[1fr_auto] items-start gap-4 border-b border-rule py-4">
      <div className="min-w-0">
        <p
          className="font-display text-[18px] leading-tight text-ink truncate"
          style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
        >
          {user.name || user.email}
          {isDisabled && (
            <span className="ml-2 align-middle font-mono text-[10px] tracking-[0.12em] uppercase text-accent-deep">
              · disabled
            </span>
          )}
        </p>
        <p className="mt-0.5 font-mono text-[11px] tracking-wider text-ink-faint truncate">
          {user.email}
          {user.confirmed === false && <span className="ml-2 text-accent-deep">invited</span>}
        </p>
      </div>

      <div className="flex flex-col items-end gap-2">
        <select
          aria-label={`Role for ${user.email}`}
          value={user.role}
          disabled={busy}
          onChange={(e) => setRole.mutate(e.target.value as UserRole)}
          className={SELECT_CLASSES}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className={ACTION_CLASSES}
            disabled={busy}
            onClick={() => toggleStatus.mutate()}
          >
            {isDisabled ? "Enable" : "Disable"}
          </button>
          <button
            type="button"
            className={ACTION_CLASSES}
            disabled={busy}
            onClick={() => resendInvite.mutate()}
          >
            Resend invite
          </button>
          <button
            type="button"
            className={ACTION_CLASSES}
            disabled={busy}
            onClick={() => revokeSessions.mutate()}
          >
            Revoke sessions
          </button>
          <button
            type="button"
            className={`${ACTION_CLASSES} text-accent-deep hover:text-accent-deep`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete ${user.email}? This cannot be undone.`)) {
                remove.mutate();
              }
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

/** Email shape mirror of the backend wrapper's guard (defense in depth). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Create user" dialog: invite a new user with a chosen role. */
function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("viewer");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const mut = useMutation({
    mutationFn: () => adminUsersApi.create({ email: email.trim(), role }),
    onSuccess: (u) => {
      toast.success(`Invite sent to ${u.email}`);
      qc.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      onClose();
    },
    onError: (e: Error) => {
      setError(e.message);
      toast.error(`Couldn't create user — ${e.message}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    mut.mutate();
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-ink/30 z-40"
        onClick={() => {
          if (!mut.isPending) onClose();
        }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create user"
        className="fixed inset-x-0 top-16 mx-auto z-50 max-w-[480px] bg-paper border border-rule shadow-2xl"
      >
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <header className="flex items-center justify-between">
            <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-ink-faint">
              Invite · New user
            </p>
            <button
              type="button"
              onClick={onClose}
              disabled={mut.isPending}
              className="text-ink-faint hover:text-ink disabled:opacity-40"
              aria-label="Close"
            >
              ×
            </button>
          </header>

          <p className="text-[13px] text-ink-soft leading-relaxed">
            An invite email with a magic sign-in link is sent immediately. The account starts
            with the role you pick here; you can change it afterwards.
          </p>

          <div>
            <label
              htmlFor="create-email"
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1 block"
            >
              Email
            </label>
            <input
              id="create-email"
              type="email"
              aria-label="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@bowtie.com.hk"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
            />
          </div>

          <div>
            <label
              htmlFor="create-role"
              className="font-mono text-[10px] tracking-[0.18em] uppercase text-ink-faint mb-1 block"
            >
              Role
            </label>
            <select
              id="create-role"
              aria-label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full border-b border-rule bg-transparent py-1 text-[14px] focus:outline-none focus:border-ink"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p role="alert" className="text-accent-deep text-[12px]">
              {error}
            </p>
          )}

          <footer className="flex items-center justify-end gap-3 pt-2 border-t border-rule">
            <button
              type="button"
              onClick={onClose}
              disabled={mut.isPending}
              className="text-[12px] uppercase tracking-wider text-ink-faint hover:text-ink disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mut.isPending || !email}
              className="bg-ink text-paper px-4 py-2 text-[12px] tracking-wider uppercase disabled:opacity-40"
            >
              {mut.isPending ? "Inviting…" : "Send invite"}
            </button>
          </footer>
        </form>
      </div>
    </>
  );
}

export default function AdminUsersPage() {
  const { can, isLoading: roleLoading } = useRole();
  const isAdmin = can("manage_users");
  const [creating, setCreating] = useState(false);

  const usersQ = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: () => adminUsersApi.list(),
    enabled: isAdmin,
  });

  return (
    <div className="mx-auto max-w-[820px] px-5 md:px-10 py-10">
      <SectionHead
        kicker="Desk · Administration"
        hed="Users & Roles"
        dek="Grant the role each teammate needs. Roles are cumulative: viewer < author < reviewer < admin."
      />

      {roleLoading && <p className="text-ink-faint">Checking your access…</p>}

      {!roleLoading && !isAdmin && (
        <div className="mt-8 border border-rule bg-paper-deep/40 p-6">
          <p className="kicker text-accent-deep">Not authorized</p>
          <p className="mt-2 text-[13px] text-ink-soft">
            Managing users requires the admin role. Ask an administrator if you need access.
          </p>
        </div>
      )}

      {!roleLoading && isAdmin && (
        <section className="mt-8">
          <div className="flex items-center justify-end mb-4">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="bg-ink text-paper px-4 py-2 text-[12px] tracking-wider uppercase hover:opacity-90"
            >
              Create user
            </button>
          </div>

          {usersQ.isLoading && <p className="text-ink-faint">Loading users…</p>}
          {usersQ.isError && (
            <p className="text-accent-deep text-[13px]">
              Failed to load users — {(usersQ.error as Error).message}
            </p>
          )}
          {usersQ.data && usersQ.data.length === 0 && (
            <p className="text-ink-faint text-[13px]">No users found.</p>
          )}
          {usersQ.data && usersQ.data.length > 0 && (
            <ul className="border-t border-rule">
              {usersQ.data.map((u) => (
                <UserRow key={u.id} user={u} />
              ))}
            </ul>
          )}
        </section>
      )}

      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
