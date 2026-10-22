import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

interface StatusBarButtonProps extends ComponentPropsWithoutRef<"button"> {
  icon: ReactNode;
  label?: ReactNode;
  reading?: ReactNode;
}

/** One geometry for every status-bar popover trigger, including app memory. */
export const StatusBarButton = forwardRef<HTMLButtonElement, StatusBarButtonProps>(function StatusBarButton(
  { icon, label, reading, className = "", type = "button", ...props }, ref,
) {
  return <button {...props} ref={ref} type={type} className={`ui-status-control ui-focus-ring ${className}`}>
    <span className="ui-status-control-icon" aria-hidden="true">{icon}</span>
    {label != null && <span className="ui-status-control-label">{label}</span>}
    {reading != null && <span className="ui-status-control-value">{reading}</span>}
  </button>;
});
