import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createLink } from '@tanstack/react-router'
import { HugeiconsIcon } from '@hugeicons/react'
import type { IconSvgElement } from '@hugeicons/react'

type NavLinkInnerProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  icon: IconSvgElement
  label: string
}

// `createLink` (docs: "Custom Link") wraps this as `_asChild` and renders it AS the anchor —
// `Link`'s resolved href/onClick/aria-current/etc land here as plain anchor props, so this
// has to spread them onto a real <a>, not just render icon+label. In exchange, `NavLink`'s
// `to` prop stays checked against the generated route tree (`ComponentProps<typeof Link>`
// would erase that — a typo'd route would only fail at runtime, not `tsc`).
const NavLinkInner = forwardRef<HTMLAnchorElement, NavLinkInnerProps>(
  ({ icon, label, ...anchorProps }, ref) => (
    <a ref={ref} {...anchorProps}>
      <HugeiconsIcon icon={icon} className="icon icon-lg" />
      <span>{label}</span>
    </a>
  ),
)

/** One rail destination: icon + label, active state via router match (docs/design.md §4.1). */
export const NavLink = createLink(NavLinkInner)

export function NavSep(): ReactNode {
  return <div className="nav-sep" />
}
