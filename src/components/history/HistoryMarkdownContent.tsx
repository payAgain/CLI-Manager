import { MarkdownContent, type MarkdownContentProps } from "../ui/MarkdownContent";

type HistoryMarkdownVariant = "history" | "terminal";

interface HistoryMarkdownContentProps extends Omit<MarkdownContentProps, "variant"> {
  variant?: HistoryMarkdownVariant;
}

export function HistoryMarkdownContent({
  variant = "history",
  ...props
}: HistoryMarkdownContentProps) {
  return <MarkdownContent {...props} variant={variant === "terminal" ? "terminal" : "default"} />;
}
