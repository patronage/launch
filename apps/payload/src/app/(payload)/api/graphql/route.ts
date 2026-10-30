// Payload adapter: load configuration only in the request context.
import { payloadRoute } from "@/lib/payload-config";
import { GRAPHQL_POST, REST_OPTIONS } from '@payloadcms/next/routes'

export const POST = payloadRoute(GRAPHQL_POST)

export const OPTIONS = payloadRoute(REST_OPTIONS)
