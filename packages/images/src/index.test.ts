import { describe, expect, it, vi } from "vitest";

import type { ImagesBinding } from ".";
import {
  imagePath,
  imageSrcset,
  negotiateFormat,
  rewriteMediaUrls,
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
