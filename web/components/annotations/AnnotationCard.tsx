import type { ReactNode, Ref } from "react";

interface Props {
  /** Highlighted (accent ring) when this card is the focused annotation. */
  focused: boolean;
  /** Dim the card once its thread is resolved. Defaults to false. */
  resolved?: boolean;
  onClick?: () => void;
  /** For scroll-into-view on focus (review threads). */
  cardRef?: Ref<HTMLLIElement>;
  children: ReactNode;
}

/**
 * The focusable bordered card shell shared by the AI-edit comment list and the
 * review-thread list. One canonical class order + focus ring so the two lists
 * stay visually identical by construction.
 */
export function AnnotationCard({ focused, resolved = false, onClick, cardRef, children }: Props) {
  return (
    <li
      ref={cardRef}
      onClick={onClick}
      className={`cursor-pointer rounded border bg-paper p-3 transition-shadow ${
        focused ? "border-accent/60 shadow-md" : "border-rule"
      } ${resolved ? "opacity-60" : ""}`}
    >
      {children}
    </li>
  );
}
