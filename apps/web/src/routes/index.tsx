import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <h1 className="p-8 bg-paper font-sans text-ink rounded rounded-xs rounded-4xl text-sm">
      cockpit
    </h1>
  )
}
