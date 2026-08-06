// Stand-in for a section's real content — this slice builds routing and the frame only.
// Same shape as prototype/frame.html's `.slot`: a dashed content-region box, not a heading
// (the breadcrumb in the bar is already the page title, per docs/design.md §4.2).
export function PagePlaceholder({ label }: { label: string }) {
  return (
    <div
      className="flex flex-1 min-h-[320px] items-center justify-center border border-dashed"
      style={{ borderColor: 'var(--color-ink-20)', color: 'var(--color-ink-40)' }}
    >
      <span className="label">{label}</span>
    </div>
  )
}
