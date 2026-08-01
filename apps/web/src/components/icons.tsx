/**
 * Function index:
 * - LightweightIcon: shared SVG wrapper.
 * - DashboardIcon, CalendarIcon, CustomersIcon, TasksIcon, SettingsIcon, ChevronIcon, ArrowIcon, BuildingIcon.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function LightweightIcon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function DashboardIcon(props: IconProps) {
  return (
    <LightweightIcon {...props}>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </LightweightIcon>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <LightweightIcon {...props}>
      <path d="M7 3v3M17 3v3M4 9h16" />
      <rect x="4" y="5" width="16" height="16" rx="3" />
    </LightweightIcon>
  );
}

export function CustomersIcon(props: IconProps) {
  return (
    <LightweightIcon {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </LightweightIcon>
  );
}

export function TasksIcon(props: IconProps) {
  return (
    <LightweightIcon {...props}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </LightweightIcon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <LightweightIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.11.37.32.71.6 1 .29.29.67.49 1.1.4H21v4h-.09a1.7 1.7 0 0 0-1.51.6Z" />
    </LightweightIcon>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <LightweightIcon {...props}>
      <path d="m9 18 6-6-6-6" />
    </LightweightIcon>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <LightweightIcon {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </LightweightIcon>
  );
}

export function BuildingIcon(props: IconProps) {
  return (
    <LightweightIcon {...props}>
      <path d="M3 21h18M6 21V5l6-2 6 2v16M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1" />
    </LightweightIcon>
  );
}
