/**
 * The few Cloudflare API calls the scripts make that the cf CLI has no
 * command for. Every call checks the HTTP status and Cloudflare's `success`
 * flag, and a failure never prints the response body, which can echo
 * submitted secret values.
 */
import { z } from "zod";

import { ScriptError } from "./script.ts";
import type { ScriptContext } from "./script.ts";

const API_BASE = "https://api.cloudflare.com/client/v4";

export interface Credentials {
  accountId: string;
  apiToken: string;
}

export const credentials = (ctx: ScriptContext): Credentials => {
  const accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = ctx.env.CLOUDFLARE_API_TOKEN;

  if (!(accountId && apiToken)) {
    throw new ScriptError(
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."
    );
  }

  return { accountId, apiToken };
};

export interface ApiRequest {
  /** What the call does, for the error message: "Listing Workers". */
  action: string;
  body?: object;
  contentType?: string;
  method?: "GET" | "PATCH";
  /** Relative to /accounts/{account_id}. */
  path: string;
}

const envelopeSchema = z.object({
  errors: z.array(z.object({ code: z.number() }).loose()).catch([]),
  result: z.unknown().optional(),
  success: z.boolean(),
});

const send = async (
  ctx: ScriptContext,
  { accountId, apiToken }: Credentials,
  {
    action,
    body,
    contentType = "application/json",
    method = "GET",
    path,
  }: ApiRequest
) => {
  const authorization = `Bearer ${apiToken}`;

  const init: RequestInit =
    body === undefined
      ? { headers: { authorization }, method }
      : {
          body: JSON.stringify(body),
          headers: { authorization, "content-type": contentType },
          method,
        };

  try {
    return await ctx.fetch(
      `${API_BASE}/accounts/${encodeURIComponent(accountId)}${path}`,
      init
    );
  } catch {
    throw new ScriptError(
      `${action} failed: the Cloudflare API was unreachable.`
    );
  }
};

/**
 * Make an account-scoped API call and return its `result`, parsed with
 * `schema`.
 */
export const cloudflareApi = async <T>(
  ctx: ScriptContext,
  creds: Credentials,
  request: ApiRequest,
  schema: z.ZodType<T>
): Promise<T> => {
  const response = await send(ctx, creds, request);

  const envelope = envelopeSchema.safeParse(
    await response.json().catch(() => null)
  );

  if (!(response.ok && envelope.success && envelope.data.success)) {
    const codes = envelope.success
      ? envelope.data.errors.map((entry) => entry.code)
      : [];

    const detail =
      codes.length > 0 ? `, Cloudflare error ${codes.join(", ")}` : "";

    throw new ScriptError(
      `${request.action} failed (HTTP ${response.status}${detail}).`
    );
  }

  const result = schema.safeParse(envelope.data.result);

  if (!result.success) {
    throw new ScriptError(`${request.action} returned an unexpected result.`);
  }

  return result.data;
};
