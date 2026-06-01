// Unauthenticated auth pages. These render outside the SetupGate / Masthead
// app chrome and are exempt from the optimistic proxy redirect (see proxy.ts).
export const AUTH_ROUTES = ["/login", "/signup", "/verify"] as const;

export function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}
