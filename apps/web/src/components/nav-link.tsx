import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createLink } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import type { IconSvgElement } from '@hugeicons/react'

type NavLinkInnerProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  icon: IconSvgElement
  label: string
  // Left undefined by the caller whenever there's nothing honest to show — data hasn't
  // arrived yet, the query errored, or (for an `attention` badge) the real count is zero.
  // `undefined` renders no badge at all; it is never coerced to a displayed "0".
  count?: number
  // Marks this as an attention badge — info-blue because the counted things are *pending*
  // (design.md §2.3's info row), not the plain ink-40 count — and, when a count is
  // present, the collapsed-rail dot (frame.css
  // `[data-rail='collapsed'] .nav a[data-badge]::after`).
  attention?: boolean
}

// `createLink` (docs: "Custom Link") wraps this as `_asChild` and renders it AS the anchor —
// `Link`'s resolved href/onClick/aria-current/etc land here as plain anchor props, so this
// has to spread them onto a real <a>, not just render icon+label. In exchange, `NavLink`'s
// `to` prop stays checked against the generated route tree (`ComponentProps<typeof Link>`
// would erase that — a typo'd route would only fail at runtime, not `tsc`).
const NavLinkInner = forwardRef<HTMLAnchorElement, NavLinkInnerProps>(
  ({ icon, label, count, attention, ...anchorProps }, ref) => (
    <a ref={ref} data-badge={(attention && count !== undefined) || undefined} {...anchorProps}>
      <HugeiconsIcon icon={icon} className="icon icon-lg" />
      <span>{label}</span>
      {count !== undefined && (
        <span className="count" data-attention={attention || undefined}>
          {count}
        </span>
      )}
    </a>
  ),
)

/** One rail destination: icon + label, active state via router match (docs/design.md §4.1). */
export const NavLink = createLink(NavLinkInner)

export function NavSep(): ReactNode {
  return <div className="nav-sep" />
}
