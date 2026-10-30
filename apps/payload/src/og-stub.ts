// Payload's admin OG image route is the only `next/og` import. Its renderer adds
// about 2 MB of wasm to the Worker, so the route answers 404 instead.
export class ImageResponse extends Response {
  constructor() {
    super(null, { status: 404 });
  }
}
