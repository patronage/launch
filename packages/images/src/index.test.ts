import { describe, expect, it, vi } from "vitest";

import type { ImagesBinding } from ".";
import {
  imagePath,
  negotiateFormat,
  rewriteImageUrls,
  serveImage,
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

  it.each([
    ["a missing original", null],
    ["a 404", new Response("gone", { status: 404 })],
    [
      "SVG",
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
    ],
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

describe(rewriteImageUrls, () => {
  const prefix = "https://cms.example.com/wp-content/uploads/";

  it("rewrites src and every srcset candidate under the prefix", () => {
    const html = `<figure><img src="${prefix}2026/10/beds.jpg" srcset="${prefix}2026/10/beds-300x200.jpg 300w, ${prefix}2026/10/beds.jpg 1024w" alt="Beds"></figure>`;

    expect(rewriteImageUrls(html, prefix)).toBe(
      '<figure><img src="/media/2026/10/beds.jpg" srcset="/media/2026/10/beds-300x200.jpg 300w, /media/2026/10/beds.jpg 1024w" alt="Beds"></figure>'
    );
  });

  it("leaves other hosts, links and non-raster files alone", () => {
    const html = `<a href="${prefix}2026/10/beds.jpg">Full size</a><img src='https://elsewhere.example/a.jpg'><video src="${prefix}2026/10/tour.mp4"></video><img src="${prefix}logo.svg">`;

    expect(rewriteImageUrls(html, prefix)).toBe(html);
  });

  it("handles newline-separated srcset candidates and spaces around =", () => {
    const html = `<img src = "${prefix}a.jpg" srcset="${prefix}a-300.jpg 300w,\n${prefix}a.jpg 1024w">`;

    expect(rewriteImageUrls(html, prefix)).toBe(
      '<img src = "/media/a.jpg" srcset="/media/a-300.jpg 300w,\n/media/a.jpg 1024w">'
    );
  });

  it("leaves an escaped tag in a code block alone", () => {
    const html = `<pre><code>&lt;img src="${prefix}a.jpg"&gt;</code></pre>`;

    expect(rewriteImageUrls(html, prefix)).toBe(html);
  });
});
