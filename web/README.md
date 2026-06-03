This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy (Cloudflare Workers)

Production hosts this frontend as a Cloudflare Worker built with
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) (OpenNext).

- **Service:** `bowtie-content-tool-web`
- **URL:** https://bowtie-content-tool-web.fmc.workers.dev
- **Backend it talks to:** the Workers-native backend
  `bowtie-content-tool-poc` (https://bowtie-content-tool-poc.fmc.workers.dev) —
  REST via Next `rewrites()` (server-side), SSE direct from the browser with CORS.

CI deploys both Workers on push to `main` via
`.github/workflows/deploy-workers.yml`. Manual commands:

```bash
npm run cf:build     # OpenNext build into .open-next/
npm run cf:preview   # build + local preview
npm run cf:deploy    # build + deploy the Worker
```

`NEXT_PUBLIC_API_BASE` is a build-time public var (inlined into the bundle); pass
it when building, e.g.
`NEXT_PUBLIC_API_BASE=https://bowtie-content-tool-poc.fmc.workers.dev npm run cf:deploy`.
See `wrangler.jsonc` and `open-next.config.ts` for the Worker config.

The same Next build also runs for local dev — Cloudflare is only the production
hosting target.
