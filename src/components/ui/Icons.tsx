// Barrel over lucide-react so swapping the icon set later touches one file.
import {
  Activity,
  Command,
  GitBranch,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Settings2,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from "lucide-react";

interface IconProps {
  className?: string;
  size?: number;
}

export function IconPencil({ className, size = 14 }: IconProps) {
  return <Pencil className={className} size={size} aria-hidden />;
}

export function IconClose({ className, size = 14 }: IconProps) {
  return <X className={className} size={size} aria-hidden />;
}

export function IconMic({ className, size = 14 }: IconProps) {
  return <Mic className={className} size={size} aria-hidden />;
}

export function IconCommand({ className, size = 14 }: IconProps) {
  return <Command className={className} size={size} aria-hidden />;
}

export function IconPlus({ className, size = 14 }: IconProps) {
  return <Plus className={className} size={size} aria-hidden />;
}

export function IconGitBranch({ className, size = 12 }: IconProps) {
  return <GitBranch className={className} size={size} aria-hidden />;
}

export function IconSettings({ className, size = 14 }: IconProps) {
  return <Settings2 className={className} size={size} aria-hidden />;
}

export function IconActivity({ className, size = 14 }: IconProps) {
  return <Activity className={className} size={size} aria-hidden />;
}

export function IconSplitVertical({ className, size = 14 }: IconProps) {
  return <SquareSplitVertical className={className} size={size} aria-hidden />;
}

export function IconSplitHorizontal({ className, size = 14 }: IconProps) {
  return <SquareSplitHorizontal className={className} size={size} aria-hidden />;
}

export function IconSidebarCollapse({ className, size = 14 }: IconProps) {
  return <PanelLeftClose className={className} size={size} aria-hidden />;
}

export function IconSidebarExpand({ className, size = 14 }: IconProps) {
  return <PanelLeftOpen className={className} size={size} aria-hidden />;
}
