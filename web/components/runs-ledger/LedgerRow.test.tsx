import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Persona, PublishTarget, RunSummary, WpCategoryOption, WpUserOption } from "@/lib/types";

import { LedgerRow, type RowView } from "./LedgerRow";
import type { OptionMaps } from "./useWpOptionMaps";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: "abcd1234ef567890",
    status: "hitl_2",
    topic: "Health insurance basics",
    article_url: "https://gobowtie.com/blog/health",
    mode: "full_rewrite",
    created_at: "2026-06-12T09:30:00Z",
    chosen_route: null,
    iteration_count: 0,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<OptionMaps> = {}): OptionMaps {
  const users = new Map<number, WpUserOption>([
    [7, { id: 7, name: "Alice Chan", slug: "alice" }],
  ]);
  const categories = new Map<number, WpCategoryOption>([
    [3, { id: 3, name: "Insurance", slug: "insurance" }],
    [5, { id: 5, name: "Health", slug: "health" }],
  ]);
  return { users, categories, ...overrides };
}

function makeView(overrides: Partial<RowView> = {}): RowView {
  return {
    selected: false,
    open: false,
    onToggleSelect: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  };
}

// LedgerRow renders a <tr>, so it must live inside a table to be valid DOM.
function renderRow(props: {
  run: RunSummary;
  view: RowView;
  personaBySlug?: Map<string, Persona>;
  targetById?: Map<string, PublishTarget>;
  options?: OptionMaps;
}) {
  return render(
    <table>
      <tbody>
        <LedgerRow
          run={props.run}
          view={props.view}
          personaBySlug={props.personaBySlug ?? new Map()}
          targetById={props.targetById ?? new Map()}
          options={props.options ?? makeOptions()}
        />
      </tbody>
    </table>,
  );
}

describe("LedgerRow flags", () => {
  it("shows a `rewrite` flag for refresh runs", () => {
    renderRow({ run: makeRun({ start_mode: "refresh" }), view: makeView() });
    expect(screen.getByText("rewrite")).toBeInTheDocument();
  });

  it("shows a `new` flag for create runs", () => {
    renderRow({ run: makeRun({ start_mode: "create" }), view: makeView() });
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("shows a `brief` flag when edit_note is set", () => {
    renderRow({ run: makeRun({ edit_note: "Tighten the intro" }), view: makeView() });
    expect(screen.getByText("brief")).toBeInTheDocument();
  });

  it("shows a `rev N` flag when hitl_2_iteration > 0", () => {
    renderRow({ run: makeRun({ hitl_2_iteration: 2 }), view: makeView() });
    expect(screen.getByText("rev 2")).toBeInTheDocument();
  });

  it("omits the rev flag when iteration is 0", () => {
    renderRow({ run: makeRun({ hitl_2_iteration: 0 }), view: makeView() });
    expect(screen.queryByText(/^rev /)).not.toBeInTheDocument();
  });
});

describe("LedgerRow id line", () => {
  it("renders the first 8 chars of the run id", () => {
    renderRow({ run: makeRun({ run_id: "abcd1234ef567890" }), view: makeView() });
    expect(screen.getByText("abcd1234")).toBeInTheDocument();
  });

  it("renders `TAG#postId` when a WP post has been pushed (default WP tag)", () => {
    renderRow({ run: makeRun({ wp_pushed_post_id: 4175 }), view: makeView() });
    expect(screen.getByText("WP#4175")).toBeInTheDocument();
  });
});

describe("LedgerRow CMS destination", () => {
  it("resolves the author name from options.users by wp_author_id", () => {
    renderRow({ run: makeRun({ wp_author_id: 7 }), view: makeView() });
    expect(screen.getByText("Alice Chan")).toBeInTheDocument();
  });

  it("resolves category names from options.categories by wp_category_ids", () => {
    renderRow({ run: makeRun({ wp_category_ids: [3, 5] }), view: makeView() });
    expect(screen.getByText("Insurance, Health")).toBeInTheDocument();
  });

  it("shows `unset` for an absent author", () => {
    renderRow({ run: makeRun({ wp_author_id: null, wp_category_ids: null }), view: makeView() });
    // Both author + category lines fall back to the same "unset" label.
    expect(screen.getAllByText("unset").length).toBeGreaterThanOrEqual(1);
  });
});

describe("LedgerRow interactions", () => {
  it("calls onOpen with the run id when the row is clicked", async () => {
    const user = userEvent.setup();
    const view = makeView();
    renderRow({ run: makeRun({ run_id: "row-open-id" }), view });
    await user.click(screen.getByText("Health insurance basics"));
    expect(view.onOpen).toHaveBeenCalledWith("row-open-id");
  });

  it("toggles selection without opening when the checkbox is clicked", async () => {
    const user = userEvent.setup();
    const view = makeView();
    renderRow({ run: makeRun({ run_id: "row-cb-id" }), view });
    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);
    expect(view.onToggleSelect).toHaveBeenCalledWith("row-cb-id");
    // The checkbox cell stops propagation, so the row's onOpen must NOT fire.
    expect(view.onOpen).not.toHaveBeenCalled();
  });
});
