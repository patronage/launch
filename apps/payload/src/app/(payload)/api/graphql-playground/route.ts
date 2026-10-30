// Payload adapter: load configuration only in the request context.
import { payloadRoute } from "@/lib/payload-config";
import '@payloadcms/next/css'
import { GRAPHQL_PLAYGROUND_GET } from '@payloadcms/next/routes'

export const GET = payloadRoute(GRAPHQL_PLAYGROUND_GET)
