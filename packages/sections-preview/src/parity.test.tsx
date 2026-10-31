import { PageSections } from "@launch/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { normalizeMarkup } from "./normalize";
import { FIXTURE_NAMES, payloadPage, wordpressPage } from "./pages";

describe.each(FIXTURE_NAMES)("WordPress and Payload %s fixtures", (name) => {
  const wp = wordpressPage(name);
  const payload = payloadPage(name);

  it("map to the same content model apart from ids and rich text", () => {
    const strip = (page: typeof wp) =>
      JSON.parse(
        JSON.stringify(page, (key, value) =>
          ["body", "confirmation", "id", "message"].includes(key)
            ? undefined
            : value
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
