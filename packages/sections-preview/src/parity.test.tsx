import { PageSections } from "@launch/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { normalizeMarkup } from "./normalize";
import { payloadPage, wordpressPage } from "./pages";

describe("WordPress and Payload fixtures", () => {
  const wp = wordpressPage();
  const payload = payloadPage();

  it("map to the same content model apart from ids and rich text", () => {
    const strip = (page: typeof wp) =>
      JSON.parse(
        JSON.stringify(page, (key, value) =>
          key === "id" || key === "body" ? undefined : value
        )
      );

    expect(strip(payload)).toStrictEqual(strip(wp));
  });

  it("render the same markup", () => {
    const render = (page: typeof wp) =>
      normalizeMarkup(renderToStaticMarkup(<PageSections page={page} />));

    expect(render(payload)).toBe(render(wp));
  });
});
