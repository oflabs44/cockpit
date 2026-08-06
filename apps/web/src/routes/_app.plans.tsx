import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '#/components/page-placeholder'

export const Route = createFileRoute('/_app/plans')({
  staticData: { title: 'Plans' },
  component: () => <PagePlaceholder label="content region" />,
})
