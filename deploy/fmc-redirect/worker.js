// Redirect stub for the sunset fmc.workers.dev account (2026-07-07).
// Deployed IN PLACE OF the old frontend Workers on the fmc account so
// bookmarks and old Slack links keep working. The fmc backends are deleted,
// not redirected — workflow/DO state is account-local, so an API redirect
// would point at a backend that has no state for those runs anyway.
const TARGETS = {
	"bowtie-content-tool-web.fmc.workers.dev": "bowtie-content-tool-web.franco-ma.workers.dev",
	"bowtie-content-tool-web-dev.fmc.workers.dev": "bowtie-content-tool-web-dev.franco-ma.workers.dev",
};

export default {
	fetch(request) {
		const url = new URL(request.url);
		url.hostname = TARGETS[url.hostname] ?? "bowtie-content-tool-web.franco-ma.workers.dev";
		return Response.redirect(url.toString(), 301);
	},
};
