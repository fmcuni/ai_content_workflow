import { redirect } from "next/navigation";

// `/runs` has no list of its own — the front page (`/`) is the runs desk, and
// the nav "Runs" link points there. Anyone who types or bookmarks the bare
// `/runs` path used to hit a 404; send them to the desk instead.
export default function RunsIndex() {
  redirect("/");
}
