import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '#/components/page-placeholder'

export const Route = createFileRoute('/_app/activity')({
  staticData: { title: 'Activity' },
  component: () => <PagePlaceholder label="content region" />,
})
