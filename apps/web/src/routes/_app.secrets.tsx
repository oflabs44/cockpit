import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '#/components/page-placeholder'

export const Route = createFileRoute('/_app/secrets')({
  staticData: { title: 'Secrets' },
  component: () => <PagePlaceholder label="content region" />,
})
