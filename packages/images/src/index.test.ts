import { describe, expect, it, vi } from "vitest";

import type { ImagesBinding } from ".";
import {
  cropSrc,
  formatGravity,
  imagePath,
  imageSrcset,
  imageTransform,
  negotiateFormat,
  rewriteMediaUrls,
  serveImage,
  signedCropSrc,
  sourcePath,
} from ".";

describe(imagePath, () => {
  const prefix = "https://cms.example.com/wp-content/uploads/";

  it("routes images below the prefix through the image route", () => {
    expect(imagePath(`${prefix}2026/10/beds.jpg`, prefix)).toBe(
      "/media/2026/10/beds.jpg"
    );
  });

  it("leaves other URLs alone", () => {
    expect(imagePath("https://elsewhere.example/a.jpg", prefix)).toBe(
      "https://elsewhere.example/a.jpg"
    );
    expect(imagePath(prefix, prefix)).toBe(prefix);
  });
});

describe(imageSrcset, () => {
  it("offers each route width up to the original's", () => {
    expect(imageSrcset("/media/beds.jpg", 1000)).toBe(
      "/media/beds.jpg?w=480 480w, /media/beds.jpg?w=768 768w, /media/beds.jpg?w=1024 1000w"
    );
  });

  it("stops at an original that matches a route width", () => {
    expect(imageSrcset("/media/beds.jpg", 480)).toBe(
      "/media/beds.jpg?w=480 480w"
    );
  });

  it("offers every width when the original's is unknown or wider", () => {
    const all =
      "/media/a.png?w=480 480w, /media/a.png?w=768 768w, /media/a.png?w=1024 1024w, /media/a.png?w=1280 1280w, /media/a.png?w=1600 1600w";

    expect(imageSrcset("/media/a.png")).toBe(all);
    expect(imageSrcset("/media/a.png", 4000)).toBe(all);
  });

  it("has none for files the route doesn't resize", () => {
    expect(imageSrcset("/media/logo.svg", 300)).toBeUndefined();
    expect(imageSrcset("https://elsewhere.example/a.jpg", 300)).toBeUndefined();
    expect(imageSrcset("/api/media/file/a.jpg", 300)).toBeUndefined();
  });
});

describe(cropSrc, () => {
  it("adds the ratio and a canonical gravity", () => {
    expect(
      cropSrc("/media/beds.jpg", {
        gravity: { x: 0.504, y: 0.3 },
        ratio: "3:2",
      })
    ).toBe("/media/beds.jpg?ar=3%3A2&g=0.5x0.3");
    expect(cropSrc("/media/beds.jpg?v=2", { ratio: "1:1" })).toBe(
      "/media/beds.jpg?v=2&ar=1%3A1"
    );
  });
});

describe(formatGravity, () => {
  it("clamps and rounds coordinates", () => {
    expect(formatGravity({ x: -1, y: 1.4 })).toBe("0x1");
    expect(formatGravity({ x: 0.125, y: 0.999 })).toBe("0.13x1");
    expect(formatGravity("face")).toBe("face");
  });
});

describe("imageSrcset for crops", () => {
  it("offers only widths the crop fills without enlarging", () => {
    const src = cropSrc("/media/beds.jpg", { ratio: "3:2" });

    // 2000 x 800 fits a 3:2 crop 1200 wide.
    expect(imageSrcset(src, 2000, 800)).toBe(
      `${src}&w=480 480w, ${src}&w=768 768w, ${src}&w=1024 1024w`
    );
  });

  it("offers the narrowest width for a small original", () => {
    const src = cropSrc("/media/a.jpg", { ratio: "1:1" });

    expect(imageSrcset(src, 300, 300)).toBe(`${src}&w=480 480w`);
  });

  it("offers every width when the original's size is unknown", () => {
    const src = cropSrc("/media/a.jpg", { ratio: "1:1" });

    expect(imageSrcset(src)?.split(", ")).toHaveLength(5);
  });
});

const at = (query: string) =>
  new Request(`https://site.example/media/2026/10/a.jpg${query}`);

describe(imageTransform, () => {
  it("resizes without a crop", async () => {
    await expect(imageTransform(at("?w=768"))).resolves.toStrictEqual({
      fit: "scale-down",
      width: 768,
    });
  });

  it("crops to a ratio around a point, centered in the crop", async () => {
    await expect(
      imageTransform(at("?w=768&ar=3:2&g=0.25x0.7"))
    ).resolves.toStrictEqual({
      fit: "cover",
      gravity: { mode: "box-center", x: 0.25, y: 0.7 },
      height: 512,
      width: 768,
    });
  });

  it("crops from the center or by saliency", async () => {
    await expect(imageTransform(at("?w=480&ar=16:9"))).resolves.toStrictEqual({
      fit: "cover",
      height: 270,
      width: 480,
    });
    await expect(
      imageTransform(at("?w=480&ar=1:1&g=auto"))
    ).resolves.toMatchObject({ gravity: "auto" });
  });

  it.each([
    ["a gravity without a ratio", "?g=0.5x0.5"],
    ["a ratio outside the set", "?ar=7:3"],
    ["a malformed ratio", "?ar=3x2"],
    ["a non-canonical point", "?ar=1:1&g=0.50x0.5"],
    ["a point outside the image", "?ar=1:1&g=1.2x0.5"],
    ["an unknown gravity", "?ar=1:1&g=entropy"],
    ["a width outside the set", "?w=500&ar=1:1"],
  ])("refuses %s", async (_name, query) => {
    await expect(imageTransform(at(query))).resolves.toBeNull();
  });

  it("takes another set of ratios", async () => {
    await expect(
      imageTransform(at("?ar=7:3"), { ratios: ["7:3"] })
    ).resolves.toMatchObject({ height: 686, width: 1600 });
  });

  describe("with a signing key", () => {
    const key = "test-signing-key";
    const crop = { gravity: { x: 0.4, y: 0.2 }, ratio: "3:2" } as const;

    it("accepts a signed crop at any route width", async () => {
      const src = await signedCropSrc("/media/2026/10/a.jpg", crop, key);

      await expect(
        imageTransform(at(`${src.slice(src.indexOf("?"))}&w=480`), {
          signingKey: key,
        })
      ).resolves.toMatchObject({ fit: "cover", width: 480 });
    });

    it("refuses an unsigned, altered or foreign crop", async () => {
      const src = await signedCropSrc("/media/2026/10/a.jpg", crop, key);
      const query = src.slice(src.indexOf("?"));
      const other = await signedCropSrc("/media/2026/10/b.jpg", crop, key);

      const results = await Promise.all(
        [
          "?ar=3:2&g=0.4x0.2",
          query.replace("0.4x0.2", "0.5x0.2"),
          other.slice(other.indexOf("?")),
        ].map((attempt) => imageTransform(at(attempt), { signingKey: key }))
      );

      expect(results).toStrictEqual([null, null, null]);
    });

    it("lets plain resizes through unsigned", async () => {
      await expect(
        imageTransform(at("?w=768"), { signingKey: key })
      ).resolves.toMatchObject({ fit: "scale-down" });
    });
  });
});

describe(sourcePath, () => {
  it("joins and encodes segments", () => {
    expect(sourcePath(["2026", "10", "raised beds.jpg"])).toBe(
      "2026/10/raised%20beds.jpg"
    );
  });

  it("rejects traversal and empty paths", () => {
    expect(sourcePath([])).toBeNull();
    expect(sourcePath(["..", "wp-config.php"])).toBeNull();
    expect(sourcePath(["2026", ".", "a.jpg"])).toBeNull();
    expect(sourcePath(["2026", "", "a.jpg"])).toBeNull();
  });

  it("rejects a separator inside a segment", () => {
    expect(sourcePath(["../../wp-config.php"])).toBeNull();
    expect(sourcePath(["2026", "..\\a.jpg"])).toBeNull();
    expect(sourcePath(["2026/10", "a.jpg"])).toBeNull();
  });
});

describe(negotiateFormat, () => {
  it("prefers AVIF, then WebP, then JPEG", () => {
    expect(negotiateFormat("image/avif,image/webp,*/*")).toBe("image/avif");
    expect(negotiateFormat("image/webp,*/*")).toBe("image/webp");
    expect(negotiateFormat("*/*")).toBe("image/jpeg");
    expect(negotiateFormat(null)).toBe("image/jpeg");
  });
});

type Transform = ImagesBinding extends {
  input: (stream: never) => { transform: infer T };
}
  ? T
  : never;

const fakeImages = () => {
  const output = vi.fn<ReturnType<Transform>["output"]>(() =>
    Promise.resolve({ response: () => new Response("resized") })
  );

  const transform = vi.fn<Transform>(() => ({ output }));
  const binding: ImagesBinding = { input: () => ({ transform }) };

  return { binding, output, transform };
};

const request = new Request("https://site.example/media/a.jpg", {
  headers: { accept: "image/webp,*/*" },
});

describe(serveImage, () => {
  it("resizes an image to the negotiated format", async () => {
    const { binding, output, transform } = fakeImages();

    const original = new Response("jpeg bytes", {
      headers: { "content-type": "image/jpeg" },
    });

    const response = await serveImage(request, original, binding);

    expect(transform).toHaveBeenCalledWith({ fit: "scale-down", width: 1600 });
    expect(output).toHaveBeenCalledWith({ format: "image/webp", quality: 80 });
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("vary")).toBe("accept");
    await expect(response.text()).resolves.toBe("resized");
  });

  it("resizes to a requested route width", async () => {
    const { binding, transform } = fakeImages();

    const original = new Response("jpeg bytes", {
      headers: { "content-type": "image/jpeg" },
    });

    await serveImage(
      new Request("https://site.example/media/a.jpg?w=768"),
      original,
      binding
    );

    expect(transform).toHaveBeenCalledWith({ fit: "scale-down", width: 768 });
  });

  it("crops through the binding", async () => {
    const { binding, transform } = fakeImages();

    const original = new Response("jpeg bytes", {
      headers: { "content-type": "image/jpeg" },
    });

    const response = await serveImage(
      new Request("https://site.example/media/a.jpg?w=480&ar=1:1&g=0.5x0.1"),
      original,
      binding
    );

    expect(response.status).toBe(200);
    expect(transform).toHaveBeenCalledWith({
      fit: "cover",
      gravity: { mode: "box-center", x: 0.5, y: 0.1 },
      height: 480,
      width: 480,
    });
  });

  it.each(["100", "768.0", "0768", "", "wide"])(
    "answers 404 for width %j",
    async (width) => {
      const { binding, transform } = fakeImages();

      const original = new Response("jpeg bytes", {
        headers: { "content-type": "image/jpeg" },
      });

      const response = await serveImage(
        new Request(`https://site.example/media/a.jpg?w=${width}`),
        original,
        binding
      );

      expect(response.status).toBe(404);
      expect(transform).not.toHaveBeenCalled();
    }
  );

  it("serves SVG unresized in a sandbox", async () => {
    const { binding, transform } = fakeImages();

    const original = new Response("<svg/>", {
      headers: { "content-type": "image/svg+xml; charset=utf-8" },
    });

    const response = await serveImage(request, original, binding);

    expect(transform).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toMatch(
      /^default-src 'none';.*; sandbox$/u
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("<svg/>");
  });

  it("serves PDF unresized", async () => {
    const { binding, transform } = fakeImages();

    const original = new Response("%PDF-1.7", {
      headers: { "content-type": "application/pdf" },
    });

    const response = await serveImage(request, original, binding);

    expect(response.status).toBe(200);
    expect(transform).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("%PDF-1.7");
  });

  it.each([
    ["a missing original", null],
    ["a 404", new Response("gone", { status: 404 })],
    [
      "HTML",
      new Response("<html>", { headers: { "content-type": "text/html" } }),
    ],
  ])("answers 404 for %s", async (_name, original) => {
    const { binding, transform } = fakeImages();

    const response = await serveImage(request, original, binding);

    expect(response.status).toBe(404);
    expect(transform).not.toHaveBeenCalled();
  });
});

describe(rewriteMediaUrls, () => {
  const prefix = "https://cms.example.com/wp-content/uploads/";

  it("rewrites src and every srcset candidate under the prefix", () => {
    const html = `<figure><img src="${prefix}2026/10/beds.jpg" srcset="${prefix}2026/10/beds-300x200.jpg 300w, ${prefix}2026/10/beds.jpg 1024w" alt="Beds"></figure>`;

    expect(rewriteMediaUrls(html, prefix)).toBe(
      '<figure><img src="/media/2026/10/beds.jpg" srcset="/media/2026/10/beds-300x200.jpg 300w, /media/2026/10/beds.jpg 1024w" alt="Beds"></figure>'
    );
  });

  it("rewrites SVG images and links to images, SVG and PDF", () => {
    const html = `<img src="${prefix}logo.svg"><a href="${prefix}2026/10/beds.jpg">Full size</a> <a class="file" href='${prefix}2026/10/guide.pdf'>Guide</a>`;

    expect(rewriteMediaUrls(html, prefix)).toBe(
      `<img src="/media/logo.svg"><a href="/media/2026/10/beds.jpg">Full size</a> <a class="file" href='/media/2026/10/guide.pdf'>Guide</a>`
    );
  });

  it("leaves other hosts, pages and other files alone", () => {
    const html = `<a href="${prefix}../../about/">About</a><a href=" https://elsewhere.example/a.pdf ">PDF</a><img src='https://elsewhere.example/a.jpg'><video src="${prefix}2026/10/tour.mp4"></video><a href="${prefix}2026/10/notes.docx">Notes</a>`;

    expect(rewriteMediaUrls(html, prefix)).toBe(html);
  });

  it("handles newline-separated srcset candidates and spaces around =", () => {
    const html = `<img src = "${prefix}a.jpg" srcset="${prefix}a-300.jpg 300w,\n${prefix}a.jpg 1024w">`;

    expect(rewriteMediaUrls(html, prefix)).toBe(
      '<img src = "/media/a.jpg" srcset="/media/a-300.jpg 300w,\n/media/a.jpg 1024w">'
    );
  });

  it("leaves an escaped tag in a code block alone", () => {
    const html = `<pre><code>&lt;img src="${prefix}a.jpg"&gt;</code></pre>`;

    expect(rewriteMediaUrls(html, prefix)).toBe(html);
  });
});
