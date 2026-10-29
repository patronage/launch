// A changing upstream for testing the fetch cache: point UPSTREAM_URL here.
export const GET = () => Response.json({ now: new Date().toISOString() });
