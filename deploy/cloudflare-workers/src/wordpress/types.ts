export type SeoPlugin = "yoast" | "rankmath";

export interface PublishPayload {
  postId: number | null;
  title: string;
  content: string;
  excerpt: string | null;
  status: string;
  slug: string | null;
  categories: number[];
  tags: number[];
  author: number | null;
  featuredMedia: number | null;
  meta: Record<string, string>;
  ifUnmodifiedSince: string | null;
  dateGmt: string | null;
  /** "" = theme default; null = omit (leave existing post template untouched) */
  template: string | null;
}

export interface PublishResult {
  id: number;
  link: string;
  status: string;
  modifiedGmt: string;
  slug: string;
}

export interface FetchedPost {
  id: number;
  slug: string;
  link: string;
  title: string;
  contentHtml: string;
  modifiedGmt: string;
  status: string;
  author: number | null;
  categories: number[];
}

export interface WpUser {
  id: number;
  name: string;
  slug: string;
}

export interface WpCategory {
  id: number;
  name: string;
  slug: string;
}
