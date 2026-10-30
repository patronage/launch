// Payload adapter: load configuration only in the request context.
import { payloadRoute } from "@/lib/payload-config";
import '@payloadcms/next/css'
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from '@payloadcms/next/routes'

export const GET = payloadRoute(REST_GET)
export const POST = payloadRoute(REST_POST)
export const DELETE = payloadRoute(REST_DELETE)
export const PATCH = payloadRoute(REST_PATCH)
export const PUT = payloadRoute(REST_PUT)
export const OPTIONS = payloadRoute(REST_OPTIONS)
