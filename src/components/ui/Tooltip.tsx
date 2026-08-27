import type { ReactNode } from "react";

interface TooltipProps {
  content: string;
  children: ReactNode;
  below?: boolean;
}

export function Tooltip({ content, children, below = false }: TooltipProps) {
  return (
    <span
      className={below ? "tooltip tooltip--below" : "tooltip"}
      data-tooltip={content}
    >
      {children}
    </span>
  );
}
