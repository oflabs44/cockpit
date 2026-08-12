import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/$serverId/projects/$projectId/resources')({
  component: Outlet,
})
