// Payload adapter: load configuration only in the request context.
import type { Metadata } from 'next'

import { getPayloadConfig } from "@/lib/payload-config";
import { NotFoundPage, generatePageMetadata } from '@payloadcms/next/views'
import { importMap } from '../importMap'

type Args = {
  params: Promise<{
    segments: string[]
  }>
  searchParams: Promise<{
    [key: string]: string | string[]
  }>
}

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config: getPayloadConfig(), params, searchParams })

const NotFound = ({ params, searchParams }: Args) =>
  NotFoundPage({ config: getPayloadConfig(), params, searchParams, importMap })

export default NotFound
