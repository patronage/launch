// Payload adapter: load configuration only in the request context.
import type { Metadata } from 'next'

import { getPayloadConfig } from "@/lib/payload-config";
import { RootPage, generatePageMetadata } from '@payloadcms/next/views'
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

const Page = ({ params, searchParams }: Args) =>
  RootPage({ config: getPayloadConfig(), params, searchParams, importMap })

export default Page
