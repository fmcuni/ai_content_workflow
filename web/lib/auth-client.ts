"use client";
import { createAuthClient } from "better-auth/react";

// The browser talks to better-auth same-origin through the Next rewrite
// (`/api/auth/:path*` → backend `/api/auth/:path*`, path-preserving). baseURL is
// left to the current origin; basePath matches the backend mount.
export const authClient = createAuthClient({
  basePath: "/api/auth",
});

export const { signIn, signUp, signOut, useSession } = authClient;
