"use client";

import type { AnchorHTMLAttributes, ReactNode } from "react";

import { openExternal } from "@/lib/external-link";

interface ExternalLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children: ReactNode;
}

/**
 * Anchor to an external URL that works both in a browser and inside the Tauri
 * desktop shell, where `target="_blank"` is otherwise swallowed by the webview.
 *
 * The `href`/`target`/`rel` are kept for accessibility and middle-click, while
 * the click handler routes through {@link openExternal}.
 */
export function ExternalLink({ href, children, onClick, ...rest }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
