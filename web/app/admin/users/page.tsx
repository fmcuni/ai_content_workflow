"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SectionHead } from "@/components/SectionHead";
import { adminApi } from "@/lib/api";
import { ROLES } from "@/lib/roles";
import type { AdminUser, UserRole } from "@/lib/types";
import { useRole } from "@/lib/use-role";

const SELECT_CLASSES =
  "h-9 w-[160px] bg-transparent text-[13px] text-ink border-0 border-b border-rule rounded-none px-0 py-1.5 outline-none focus-visible:border-b-2 focus-visible:border-accent appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

function UserRow({ user }: { user: AdminUser }) {
  const qc = useQueryClient();
  const setRole = useMutation({
    mutationFn: (role: UserRole) => adminApi.setUserRole(user.id, role),
    onSuccess: (updated) => {
      toast.success(`${updated.email} is now ${updated.role}`);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      // The current operator may have changed their own role — refresh /me.
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e: Error) => toast.error(`Couldn't update role — ${e.message}`),
  });

  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-rule py-4">
      <div className="min-w-0">
        <p
          className="font-display text-[18px] leading-tight text-ink truncate"
          style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
        >
          {user.name || user.email}
        </p>
        <p className="mt-0.5 font-mono text-[11px] tracking-wider text-ink-faint truncate">
          {user.email}
        </p>
      </div>
      <select
        aria-label={`Role for ${user.email}`}
        value={user.role}
        disabled={setRole.isPending}
        onChange={(e) => setRole.mutate(e.target.value as UserRole)}
        className={SELECT_CLASSES}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </li>
  );
}

export default function AdminUsersPage() {
  const { can, isLoading: roleLoading } = useRole();
  const isAdmin = can("manage_users");

  const usersQ = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => adminApi.listUsers(),
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
    </div>
  );
}
