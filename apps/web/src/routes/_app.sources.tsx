import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '#/components/page-placeholder'

export const Route = createFileRoute('/_app/sources')({
  staticData: { title: 'Sources' },
  component: () => <PagePlaceholder label="content region" />,
})
