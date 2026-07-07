# fmc-redirect

301-redirect stubs deployed over the two frontend Workers on the sunset `fmc.workers.dev` account, pointing every path+query at the `franco-ma.workers.dev` equivalents. Deploy manually with fmc credentials: `npx wrangler deploy` (prod web) and `npx wrangler deploy --env dev` (dev web). The fmc backend Workers are deleted, not redirected — see the header comment in `wrangler.jsonc`.
