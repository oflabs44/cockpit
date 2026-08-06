import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '#/components/page-placeholder'

export const Route = createFileRoute('/_app/')({
  staticData: { title: 'Servers' },
  component: () => <PagePlaceholder label="content region" />,
})
