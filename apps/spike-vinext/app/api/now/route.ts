// A changing upstream for testing the fetch cache: point UPSTREAM_URL here.
export function GET() {
  return Response.json({ now: new Date().toISOString() });
}
