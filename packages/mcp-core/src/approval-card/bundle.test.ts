// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { inlineSafe } from "../../scripts/inline-safe.mjs";
import { APPROVAL_CARD_SCRIPT } from "../approval-card-bundle.generated";

// Evaluates `code` as a function body and answers what it returns, to show a
// rewrite reads the same to JavaScript.
const evaluate = (code: string): string =>
  // oxlint-disable-next-line typescript/no-implied-eval, no-new-func -- the test runs only code it wrote itself.
  String(new Function(code)());

describe(inlineSafe, () => {
  it("rewrites a closing tag and an HTML comment opener out of the code", () => {
    const code = inlineSafe(
      'return ["</script>", "</SCRIPT >", "<!-- note -->"].join("|");'
    );

    expect(code.toLowerCase()).not.toContain("</script");
    expect(code).not.toContain("</");
    expect(code).not.toContain("<!--");
  });

  it("leaves strings and regular expressions reading as they did", () => {
    const original =
      'return ["</script>", "<!-- note -->", /<\\/p>/.test("</p>")].join("|");';

    expect(evaluate(inlineSafe(original))).toBe(evaluate(original));
  });
});

describe("the generated approval card bundle", () => {
  it("contains no closing script tag and no HTML comment opener", () => {
    expect(APPROVAL_CARD_SCRIPT.length).toBeGreaterThan(0);
    expect(APPROVAL_CARD_SCRIPT.toLowerCase()).not.toContain("</script");
    expect(APPROVAL_CARD_SCRIPT).not.toContain("</");
    expect(APPROVAL_CARD_SCRIPT).not.toContain("<!--");
  });

  it("parses as one whole script element when inlined in the card", () => {
    const document = new DOMParser().parseFromString(
      `<!doctype html><html><body><div id="body"></div><script>${APPROVAL_CARD_SCRIPT}</script><p id="after"></p></body></html>`,
      "text/html"
    );

    const scripts = document.querySelectorAll("script");

    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.textContent).toBe(APPROVAL_CARD_SCRIPT);
    expect(document.querySelector("#after")).not.toBeNull();
  });
});
