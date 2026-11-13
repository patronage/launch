import { describe, expect, it } from "vitest";

import {
  extensionsFor,
  sniffFileType,
  SVG_TYPE,
  typeAllowed,
} from "./file-type";

const withHead = (head: number[] | string, length = 32): Uint8Array => {
  const bytes = new Uint8Array(length);

  bytes.set(Array.isArray(head) ? head : new TextEncoder().encode(head));

  return bytes;
};

const riff = (kind: string): Uint8Array => {
  const bytes = withHead("RIFF");

  bytes.set(new TextEncoder().encode(kind), 8);

  return bytes;
};

const isoBox = (brand: string): Uint8Array => {
  const bytes = withHead([0, 0, 0, 0x1c]);

  bytes.set(new TextEncoder().encode(`ftyp${brand}`), 4);

  return bytes;
};

describe(sniffFileType, () => {
  it.each([
    ["image/png", withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/jpeg", withHead([0xff, 0xd8, 0xff, 0xe0])],
    ["image/gif", withHead("GIF89a")],
    ["image/webp", riff("WEBP")],
    ["image/avif", isoBox("avif")],
    ["application/pdf", withHead("%PDF-1.7")],
  ])("reads %s from its first bytes", (type, bytes) => {
    expect(sniffFileType(bytes)).toBe(type);
  });

  it.each([
    "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    "\uFEFF  <?xml version='1.0'?>\n<svg></svg>",
    "<!DOCTYPE svg PUBLIC '-//W3C//DTD SVG 1.1//EN' ''><SVG></SVG>",
  ])("names SVG, so it can be refused: %s", (text) => {
    expect(sniffFileType(new TextEncoder().encode(text))).toBe(SVG_TYPE);
  });

  it("knows nothing about other files", () => {
    expect(sniffFileType(riff("WAVE"))).toBeUndefined();
    expect(sniffFileType(isoBox("mp42"))).toBeUndefined();
    expect(sniffFileType(withHead("<html><body>"))).toBeUndefined();
    expect(sniffFileType(new Uint8Array())).toBeUndefined();
    expect(sniffFileType(withHead([0x89, 0x50], 2))).toBeUndefined();
  });
});

describe(typeAllowed, () => {
  it("matches a type, a family, or anything when the list is empty", () => {
    expect(typeAllowed("image/png", ["image/png"])).toBeTruthy();
    expect(typeAllowed("image/png", ["image/*"])).toBeTruthy();
    expect(typeAllowed("image/png", [])).toBeTruthy();
    expect(typeAllowed("image/png", ["image/jpeg", "video/*"])).toBeFalsy();
    expect(typeAllowed("imagery/png", ["image/*"])).toBeFalsy();
  });
});

describe(extensionsFor, () => {
  it("lists a type's extensions, the usual one first", () => {
    expect(extensionsFor("image/jpeg")).toStrictEqual(["jpg", "jpeg"]);
    expect(extensionsFor("text/plain")).toStrictEqual([]);
  });
});
