import { redirect } from "next/navigation";

// There is no standalone topic-batch list page — batches surface on the front
// page feed ("Finish promotion →" cards) and via their detail pages. Bookmarks
// or guesses at the bare `/topic-batches` path used to 404; send them home.
export default function TopicBatchesIndex() {
  redirect("/");
}
