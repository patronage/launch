import { describe, expect, it } from "vitest";

import { isThumbnailSrc, THUMBNAIL_MAX_BYTES } from "./apply";
import { describeImage } from "./thumbnail";
import type { ThumbnailImages } from "./thumbnail";

interface Asked {
  pixels: number | undefined;
  quality: number | undefined;
}

// An Images binding stand-in: it reports one size for every picture and
// answers each transform with as many bytes as `sizeFor` says.
const fakeImages = (
  sizeFor: (asked: Asked) => number,
  options: { failInfo?: boolean; svg?: boolean } = {}
) => {
  const asked: Asked[] = [];

  const images: ThumbnailImages = {
    info: () => {
      if (options.failInfo) {
        return Promise.reject(new Error("not an image"));
      }

      return Promise.resolve(
        options.svg
          ? { format: "image/svg+xml" }
          : { fileSize: 1000, format: "image/png", height: 600, width: 800 }
      );
    },
    input: () => ({
      transform: (transform: { width?: number }) => ({
        output: (output: { quality?: number }) => {
          const request = { pixels: transform.width, quality: output.quality };

          asked.push(request);

          return Promise.resolve({
            response: () => new Response(new Uint8Array(sizeFor(request))),
          });
        },
      }),
    }),
  };

  return { asked, images };
};

const bytes = new Uint8Array([1, 2, 3]);

describe(describeImage, () => {
  it("measures a picture and makes a thumbnail the surfaces will draw", async () => {
    const { asked, images } = fakeImages(() => 2000);
    const facts = await describeImage(images, bytes);

    expect(facts).toMatchObject({ height: 600, width: 800 });
    expect(isThumbnailSrc(facts?.thumbnail ?? "")).toBeTruthy();
    expect(asked).toStrictEqual([{ pixels: 320, quality: 70 }]);
  });

  it("tries a smaller file, then a smaller picture, until one fits", async () => {
    const { asked, images } = fakeImages(({ pixels }) =>
      pixels === 160 ? 5000 : THUMBNAIL_MAX_BYTES + 1
    );

    const facts = await describeImage(images, bytes);

    expect(isThumbnailSrc(facts?.thumbnail ?? "")).toBeTruthy();
    expect(asked.map((request) => request.pixels)).toStrictEqual([
      320, 320, 160,
    ]);
  });

  it("keeps the measurements when no thumbnail is small enough", async () => {
    const { images } = fakeImages(() => THUMBNAIL_MAX_BYTES + 1);

    await expect(describeImage(images, bytes)).resolves.toStrictEqual({
      height: 600,
      width: 800,
    });
  });

  it("says nothing without a binding, or about a file it cannot measure", async () => {
    const unreadable = fakeImages(() => 10, { failInfo: true });
    const svg = fakeImages(() => 10, { svg: true });

    await expect(describeImage(undefined, bytes)).resolves.toBeUndefined();
    await expect(
      describeImage(unreadable.images, bytes)
    ).resolves.toBeUndefined();
    await expect(describeImage(svg.images, bytes)).resolves.toBeUndefined();
  });
});
