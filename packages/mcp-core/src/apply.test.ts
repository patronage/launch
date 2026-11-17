import { describe, expect, it } from "vitest";

import {
  batchReceiptSchema,
  isThumbnailSrc,
  preflightDigest,
  receiptDetails,
  RECEIPT_DETAIL_KEYS,
  THUMBNAIL_MAX_BYTES,
} from "./apply";
import type { ApplyPreflight, BatchReceipt, SnapshotImage } from "./apply";

const image: SnapshotImage = {
  bytes: 48_213,
  height: 600,
  mimeType: "image/png",
  sha256: "ab".repeat(32),
  src: "data:image/webp;base64,AAAA",
  width: 800,
};

const preflight = (afterImage: SnapshotImage): ApplyPreflight => ({
  intent: "Add a photo",
  operations: [
    {
      editUrl: "https://cms.example/admin/collections/media/create",
      fields: [
        {
          after: "garden.png",
          afterImage,
          before: "",
          changed: true,
          path: "file",
        },
      ],
      modifiedGmt: "",
      operationIndex: 0,
      sentence: "Upload garden.png to media",
      slug: "",
      target: "media/new",
      warning: "This file is public as soon as you approve.",
    },
  ],
});

const receipt = (
  operation: Partial<BatchReceipt["operations"][number]>
): BatchReceipt => ({
  approverOpaque: "approver00000000",
  executionId: "exec_1",
  operations: [
    {
      changed_paths: ["file"],
      kind: "upload_media",
      normalized_paths: [],
      operation_index: 0,
      status: "changed",
      target: "media/7",
      ...operation,
    },
  ],
  requesterOpaque: "requester0000000",
  status: "succeeded",
});

const NOT_THUMBNAILS = [
  "",
  "data:image/webp;base64,",
  "data:image/png;base64,AAAA",
  "data:image/svg+xml;base64,AAAA",
  "data:image/webp,AAAA",
  "data:image/webp;base64,AAA",
  'data:image/webp;base64,AAAA" onerror="x',
  "data:image/webp;base64,AA AA",
  "https://cdn.example/a.webp",
  ["java", "script:alert(1)"].join(""),
];

describe(isThumbnailSrc, () => {
  it("accepts a small inline WebP", () => {
    expect(isThumbnailSrc("data:image/webp;base64,AAAA")).toBeTruthy();
    expect(isThumbnailSrc("data:image/webp;base64,QUJD")).toBeTruthy();
  });

  it.each(NOT_THUMBNAILS)("refuses %j", (src) => {
    expect(isThumbnailSrc(src)).toBeFalsy();
  });

  it("refuses a thumbnail over the byte cap", () => {
    const atCap = "A".repeat(Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4);

    expect(isThumbnailSrc(`data:image/webp;base64,${atCap}`)).toBeTruthy();
    expect(isThumbnailSrc(`data:image/webp;base64,${atCap}AAAA`)).toBeFalsy();
  });
});

describe(preflightDigest, () => {
  it("covers the thumbnail and the warning an approver was shown", async () => {
    const shown = await preflightDigest(preflight(image));
    const other = preflight(image);

    for (const operation of other.operations) {
      operation.warning = "Another warning.";
    }

    await expect(preflightDigest(preflight(image))).resolves.toBe(shown);
    await expect(
      preflightDigest(
        preflight({ ...image, src: "data:image/webp;base64,BBBB" })
      )
    ).resolves.not.toBe(shown);
    await expect(preflightDigest(other)).resolves.not.toBe(shown);
  });
});

const parses = (operation: Partial<BatchReceipt["operations"][number]>) =>
  batchReceiptSchema.safeParse(receipt(operation)).success;

describe("receipt details", () => {
  it("accepts a version, a modified time and bounded details", () => {
    expect(
      parses({
        details: { id: "7", url: "/media/garden.png" },
        updated_at: "2026-11-13T04:00:00.000Z",
        version_id: "41",
      })
    ).toBeTruthy();
    expect(parses({})).toBeTruthy();
  });

  it.each([
    [
      "too many details",
      Object.fromEntries(
        Array.from({ length: RECEIPT_DETAIL_KEYS + 1 }, (_, index) => [
          `key${index}`,
          "v",
        ])
      ),
    ],
    ["a long value", { id: "x".repeat(500) }],
    ["a long key", { ["k".repeat(41)]: "v" }],
  ])("refuses %s", (_, details) => {
    expect(parses({ details })).toBeFalsy();
  });

  it("builds details that always fit the schema", () => {
    const details = receiptDetails({
      empty: "",
      id: 7,
      missing: undefined,
      nothing: null,
      url: "x".repeat(900),
      ...Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`extra${index}`, "v"])
      ),
    });

    expect(details?.id).toBe("7");
    expect(details).not.toHaveProperty("empty");
    expect(details).not.toHaveProperty("missing");
    expect(Object.keys(details ?? {})).toHaveLength(RECEIPT_DETAIL_KEYS);
    expect(parses({ details: details ?? {} })).toBeTruthy();
  });

  it("builds nothing from nothing", () => {
    expect(receiptDetails({ a: "", b: undefined })).toBeUndefined();
  });
});
