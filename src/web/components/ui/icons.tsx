import type { JSX } from 'preact'

// Stroke icons (24px grid, lucide-style paths). Decorative: the surrounding control carries the label.
function Icon(props: { children: JSX.Element | JSX.Element[]; class?: string; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={props.filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class ?? 'size-5'}
    >
      {props.children}
    </svg>
  )
}

type P = { class?: string }

export const ChevronLeft = (p: P) => (
  <Icon {...p}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
)
export const ChevronRight = (p: P) => (
  <Icon {...p}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
)
export const Calendar = (p: P) => (
  <Icon {...p}>
    <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
  </Icon>
)
export const Close = (p: P) => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
)
export const Star = (p: P & { filled?: boolean }) => (
  <Icon {...p}>
    <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" />
  </Icon>
)
export const Info = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </Icon>
)
export const Trash = (p: P) => (
  <Icon {...p}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
  </Icon>
)
export const AlbumPlus = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 8v8M8 12h8" />
  </Icon>
)
export const More = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="19" r="1" />
  </Icon>
)
export const Upload = (p: P) => (
  <Icon {...p}>
    <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
  </Icon>
)
export const Images = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-5-5L5 21" />
  </Icon>
)
export const Albums = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="7" width="18" height="14" rx="2" />
    <path d="M6 3h12M5 5h14" />
  </Icon>
)
export const Sliders = (p: P) => (
  <Icon {...p}>
    <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
    <circle cx="15" cy="6" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="18" r="2" />
  </Icon>
)
export const Wrench = (p: P) => (
  <Icon {...p}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
  </Icon>
)
export const Check = (p: P) => (
  <Icon {...p}>
    <path d="m5 13 4 4L19 7" />
  </Icon>
)
export const Select = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="m8 12 3 3 5-6" />
  </Icon>
)
export const Restore = (p: P) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
  </Icon>
)
