import type { SVGProps } from "react";

/**
 * Единый набор иконок UI-kit.
 * Правила (DESIGN-SYSTEM.md §7):
 *  - толщина линии 1.5, round cap/join;
 *  - иконка всегда aria-hidden, смысл несёт подпись рядом или aria-label;
 *  - форма значка НЕСЁТ смысл: у info — круг, у warning — треугольник,
 *    у danger — крест, у success — галочка, у accent — ромб.
 */

export type IconProps = SVGProps<SVGSVGElement> & {
  /** 12 | 14 | 16 | 20 */
  size?: 12 | 14 | 16 | 20;
};

function base({ size = 16, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...rest,
  };
}

/** Статусная форма: success — угловая замкнутая галочка. */
export function IconSuccess(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M2.5 8.5 6 12l7.5-8" />
    </svg>
  );
}

/** Статусная форма: warning — острый треугольник с «!». */
export function IconWarning(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M8 2 15 13.5H1L8 2Z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.5h.01" />
    </svg>
  );
}

/** Статусная форма: danger — разрывный крест. */
export function IconDanger(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** Статусная форма: info — единственная ОКРУГЛАЯ форма. */
export function IconInfo(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4" />
      <path d="M8 4.8h.01" />
    </svg>
  );
}

/** Статусная форма: accent / выделение — ромб. */
export function IconAccent(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8 8 1.5Z" />
    </svg>
  );
}

export function IconChevron(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

export function IconClose(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function IconSearch(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

export function IconSpinner(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="6" opacity={0.25} />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  );
}

export function IconPlan(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 6.5h5M5.5 9.5h3" />
    </svg>
  );
}

export function IconBuild(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M10.5 2.5 13.5 5.5 6 13H3v-3L10.5 2.5Z" />
    </svg>
  );
}

export function IconEdit(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M2.5 13.5h3L13 6a1.8 1.8 0 0 0-2.5-2.5L3 11v2.5Z" />
    </svg>
  );
}

export function IconAuto(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M8 1.5 9.6 5.6 13.5 6l-3 3 .8 4.2L8 11.3 4.7 13.2l.8-4.2-3-3 3.9-.4L8 1.5Z" />
    </svg>
  );
}

export function IconYolo(props: IconProps): React.ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M8 2 14 4v4.5c0 3-2.6 5-6 5.5-3.4-.5-6-2.5-6-5.5V4l6-2Z" />
      <path d="M6 8.2 7.6 10 11 6" />
    </svg>
  );
}
