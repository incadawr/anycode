/**
 * Hand-rolled 16px inline SVG icons (design ui-redesign-direction.md §2.2).
 * Zero icon dependency — a CSP-locked renderer with a couple dozen glyphs
 * doesn't warrant one. Every icon is a `currentColor`-stroked 16×16 SVG marked
 * `aria-hidden` (they are decorative; the interactive element that wraps them
 * carries the accessible name). Callers may pass through `className`/style via
 * the spread `SVGProps` for sizing or color overrides.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** Shared base: 16px viewBox, no fill, `currentColor` stroke, decorative. */
function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Plus — new session / add. */
export function Plus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </Icon>
  );
}

/** Minus — centered horizontal bar (R14: skipped workflow step). */
export function Minus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 8h9.5" />
    </Icon>
  );
}

/** Chevron — menu disclosure (points down by default; rotate via CSS). */
export function Chevron(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6l4 4 4-4" />
    </Icon>
  );
}

/** Folder — workspace group heading. */
export function Folder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 4.5A1.5 1.5 0 013.5 3h2.3a1 1 0 01.8.4l.8 1.1a1 1 0 00.8.4h4.5A1.5 1.5 0 0114 6.4V11.5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-7z" />
    </Icon>
  );
}

/** Git branch — repository / branch context. */
export function GitBranch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4" cy="3.5" r="1.25" />
      <circle cx="4" cy="12.5" r="1.25" />
      <circle cx="12" cy="5.5" r="1.25" />
      <path d="M4 4.75v4.5a3.25 3.25 0 003.25 3.25H8M4 8.5A3.25 3.25 0 017.25 5.25H10.75" />
    </Icon>
  );
}

/** Terminal — shell prompt in a frame. */
export function Terminal(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M4.75 6.25L6.5 8l-1.75 1.75M8.5 9.75h2.75" />
    </Icon>
  );
}

/** ServerStack — language-server status panel. */
export function ServerStack(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="3" width="11" height="3.5" rx="1" />
      <rect x="2.5" y="9.5" width="11" height="3.5" rx="1" />
      <path d="M5 4.75h.01M5 11.25h.01M7.5 4.75h4M7.5 11.25h4" />
    </Icon>
  );
}

/** HookIcon — command hooks panel. */
export function HookIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.75 2.75v5.5a3.75 3.75 0 1 1-7.5 0V7" />
      <path d="M10.75 2.75l2 2M10.75 2.75l-2 2M3.25 7h3" />
    </Icon>
  );
}

/** ImageIcon — attach image input. */
export function ImageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.25" r="1" />
      <path d="M4.25 11l2.75-3 2 2 1.25-1.25L13 11.5" />
    </Icon>
  );
}

/** Gear — settings. */
export function Gear(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.38 3.62l-1.13 1.13M4.75 11.25l-1.13 1.13M12.38 12.38l-1.13-1.13M4.75 4.75L3.62 3.62" />
    </Icon>
  );
}

/** X — close. */
export function X(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

/** ArrowUp — send. */
export function ArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 13V3.5M4 7.5L8 3.5l4 4" />
    </Icon>
  );
}

/** Stop — cancel the running turn (filled square). */
export function Stop(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Dot — status pill (filled circle). */
export function Dot(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Collapse — sidebar collapse/expand toggle (panel with a divider). */
export function Collapse(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 3v10" />
    </Icon>
  );
}

/**
 * Custom titlebar (design/ui-track custom-titlebar §4/§5): win/linux caption
 * button glyphs. Rendered at 12px (WindowControls sizes down via className,
 * matching the sidebar's Dot/icon-sizing idiom) — the shapes below are drawn
 * against the shared 16×16 viewBox so they stay centered when scaled.
 */

/** Minimize — single horizontal line. */
export function Minimize(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 12h9" />
    </Icon>
  );
}

/** Maximize — square outline. */
export function Maximize(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="0.5" />
    </Icon>
  );
}

/** Restore — two offset square outlines (maximize↔restore flip, design §4/§5). */
export function Restore(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="2.5" width="8" height="8" rx="0.5" />
      <rect x="2.5" y="5.5" width="8" height="8" rx="0.5" />
    </Icon>
  );
}

/** Spinner — indeterminate progress (270° arc). Rotation comes from the
 *  shared `spin` keyframe: pair with the `icon-spin` class (app.css). */
export function Spinner(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 8a6 6 0 1 1-6-6" />
    </Icon>
  );
}

/** Check — selection marker / success confirmation. */
export function Check(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Icon>
  );
}

/** Copy — duplicate to clipboard (front card over a tucked-behind sheet). */
export function Copy(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
      <path d="M3.5 10A1.5 1.5 0 0 1 2 8.5v-5A1.5 1.5 0 0 1 3.5 2h5A1.5 1.5 0 0 1 10 3.5" />
    </Icon>
  );
}

/** Clear — circle-slash, DevTools clear-console convention (R18 terminal header). */
export function Clear(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M3.95 3.95l8.1 8.1" />
    </Icon>
  );
}

/** Info — neutral/informational notice (ring + i: stem below, dot above). */
export function Info(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.25v3.5" />
      <circle cx="8" cy="5.1" r="0.95" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Warning — attention/risk notice (triangle + !: stem high, dot low). */
export function Warning(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.75L14 13H2z" />
      <path d="M8 6.25v2.75" />
      <circle cx="8" cy="11.25" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Search — magnifier (sidebar filter, R9). */
export function Search(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7.25" cy="7.25" r="3.75" />
      <path d="M10 10l3 3" />
    </Icon>
  );
}

/** FileIcon — page with a folded corner (Settings permissions editor, P7.16 §4.1: Read/Write/Edit rule groups). */
export function FileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 2.5h4.25L12 5.75V13a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" />
      <path d="M8.75 2.5v3.25H12" />
      <path d="M5.25 8.5h4.5M5.25 10.75h3" />
    </Icon>
  );
}

/** Globe — meridian over a circle (Settings permissions editor, P7.16 §4.1: WebFetch/WebSearch rule groups). */
export function Globe(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.25 8h11.5" />
      <path d="M8 2.25c1.8 1.65 2.8 3.65 2.8 5.75S9.8 12.1 8 13.75C6.2 12.1 5.2 10.1 5.2 8S6.2 3.9 8 2.25z" />
    </Icon>
  );
}

/** Ellipsis — three horizontal dots (overflow/context-menu trigger, GUI-P1 sidebar project menu). */
export function Ellipsis(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Pencil — edit affordance (P7.19/F22 W3: MCP server row edit action). */
export function Pencil(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.5 3.5l2 2L5 13H3v-2z" />
      <path d="M9.25 4.75l2 2" />
    </Icon>
  );
}

/** Trash — delete affordance (P7.19/F22 W3: MCP server row delete action). */
export function Trash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 5h9" />
      <path d="M6 5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V5" />
      <path d="M4.5 5l.6 8a1 1 0 0 0 1 .95h3.8a1 1 0 0 0 1-.95l.6-8" />
      <path d="M6.75 7.5v4M9.25 7.5v4" />
    </Icon>
  );
}

/** Robot — built-in subagent identity glyph (P7.21/F21 W3: Subagents pane built-in cards). */
export function Robot(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2v1.75" />
      <circle cx="8" cy="1.75" r="0.75" fill="currentColor" stroke="none" />
      <rect x="3.5" y="4.5" width="9" height="7.5" rx="2" />
      <circle cx="6" cy="8.25" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8.25" r="0.85" fill="currentColor" stroke="none" />
      <path d="M2 6.5v3M14 6.5v3M6 12v1M10 12v1" />
    </Icon>
  );
}

/** Person — profile identity glyph (P7.22/F19 W3: Settings Profile pane nav icon). */
export function Person(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M2.75 13.25c.6-2.85 2.75-4.5 5.25-4.5s4.65 1.65 5.25 4.5" />
    </Icon>
  );
}

/** Download — import affordance (P7.19/F22 W3: MCP Servers pane header import action). */
export function Download(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5v7.5" />
      <path d="M4.75 7.25L8 10.5l3.25-3.25" />
      <path d="M3 12.5h10" />
    </Icon>
  );
}

/** Clipboard — plan-mode affordance (P7.23/F24 W2: slash-menu "Plan mode" row). */
export function Clipboard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3" width="9" height="11" rx="1.5" />
      <rect x="6" y="2" width="4" height="2" rx="0.75" />
      <path d="M5.75 7.5h4.5M5.75 10h4.5" />
    </Icon>
  );
}

/** Sliders — permission-mode affordance (P7.23/F24 W2: slash-menu "Mode" row). */
export function Sliders(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5h13M2.5 8h13M2.5 11.5h13" />
      <circle cx="9" cy="4.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="5" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="11" cy="11.5" r="1.4" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** Cube — model affordance (P7.23/F24 W2: slash-menu "Model" row). */
export function Cube(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.25l5.25 3v5.5L8 13.75 2.75 10.75v-5.5z" />
      <path d="M2.75 5.25L8 8l5.25-2.75M8 8v5.75" />
    </Icon>
  );
}

/** Stack — sessions affordance (P7.23/F24 W2: slash-menu "Sessions" row). */
export function Stack(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4.5" width="9" height="8" rx="1.25" />
      <path d="M5 4.5V3.75A1.25 1.25 0 016.25 2.5h6A1.25 1.25 0 0113.5 3.75v6A1.25 1.25 0 0112.25 11h-.75" />
    </Icon>
  );
}

/** Keyboard — shortcuts affordance (P7.24/F20 W3: Settings "Keyboard shortcuts" pane nav icon). */
export function Keyboard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.75" y="4.25" width="12.5" height="8.5" rx="1.5" />
      <path d="M4 6.75h.01M6.25 6.75h.01M8.5 6.75h.01M10.75 6.75h.01M4 9.25h.01M12.75 9.25h.01" strokeWidth="1.9" />
      <path d="M6.25 9.25h4" />
    </Icon>
  );
}

/** History — checkpoint timeline / rewind affordance (slice P7.26/R2). A clock face with a counter-clockwise sweep, evoking "go back". */
export function History(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.25 8A5.25 5.25 0 1 1 8.75 2.77" />
      <path d="M13.25 4.25v2.5h-2.5" />
      <path d="M8 5.25V8l2 1.25" />
    </Icon>
  );
}

/**
 * BrandMark — the AnyCode app icon as a hand-authored vector (R21). NOT part
 * of the 16-grid `Icon` system: a self-contained squircle plate with its own
 * baked inks, drawn on a 48 grid. The fills below are BRAND CONSTANTS, not
 * theme tokens — like a dock icon, the mark renders identically in light and
 * dark themes, so token indirection would be a lie (and would let a theme
 * edit silently reskin the brand). Scoped here only; consumers size it via
 * className (Welcome hero 64px, Settings About 32px). Decorative: the
 * adjacent "AnyCode" wordmark carries the accessible name on both surfaces.
 *
 * Reading, top to bottom: blue `< >` bracket lens (code), white `>` prompt +
 * gray `_` cursor (the terminal), gray `✓` threading toward the lens's open
 * bottom notch (agent step done — the loop closes when the work is verified).
 */
export function BrandMark(props: IconProps) {
  return (
    <svg
      width={48}
      height={48}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {/* Plate + rim. Flat fill on purpose: the raster's top-sheen gradient is
          imperceptible below 128px and a <defs> gradient would need unique IDs
          (duplicate-ID hazard if the mark ever mounts twice); the rim alone
          separates the plate from dark surfaces. */}
      <rect x="1" y="1" width="46" height="46" rx="10.8" fill="#151B23" stroke="#2A3340" strokeWidth="1" />
      {/* Bracket lens — one path, two subpaths; round caps normalize the
          raster's cut ends to this icon set's round-cap voice. */}
      <path
        d="M21 10 L10 24 L21 38 M27 10 L38 24 L27 38"
        stroke="#319FFF"
        strokeWidth="3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Prompt chevron */}
      <path
        d="M18.7 20.2 L23.2 24.3 L18.7 28.4"
        stroke="#F4F7FB"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Cursor underscore, on the prompt's baseline */}
      <path d="M25.6 28.2 H29.4" stroke="#707A8A" strokeWidth="2.6" strokeLinecap="round" />
      {/* Check, nadir centered on the lens's bottom notch (x=24), ≥0.85u of
          air from every neighbor — tuned so nothing kisses at 32px. */}
      <path
        d="M22.6 33.5 L24.1 35.4 L26.8 31.7"
        stroke="#667082"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
