import { describe, expect, it } from "vitest";

import { previewValue } from "./apply";
import type { ApplyPreflight, BatchReceipt, OperationPreflight } from "./apply";
import {
  approvalCsrfToken,
  escapeHtml,
  renderApprovalPage,
  renderProblemPage,
  renderProgressFragment,
  renderReceiptFragment,
  renderReceiptPage,
  runEndingProblem,
  verifyApprovalCsrfToken,
  writeNotice,
} from "./approval-page";

const operation: OperationPreflight = {
  editUrl: "https://wordpress.example/wp-admin/post.php?post=42&action=edit",
  fields: [
    {
      after: "New title",
      before: "Old <b>title</b>",
      changed: true,
      path: "title",
    },
    { after: "same", before: "same", changed: false, path: "slug" },
  ],
  modifiedGmt: "2026-09-01T10:00:00",
  operationIndex: 0,
  sentence: "Update title and slug on pages 42",
  slug: "launch",
  target: "pages/42",
};

const preflight: ApplyPreflight = {
  intent: "Fix the launch <headline>",
  operations: [operation],
};

const receipt: BatchReceipt = {
  approverOpaque: "approver00000000",
  executionId: "exec_1",
  operations: [
    {
      changed_paths: ["title", "slug"],
      kind: "update_post",
      normalized_paths: ["slug"],
      operation_index: 0,
      status: "changed",
      target: "pages/42",
    },
    {
      changed_paths: [],
      error: {
        code: "readback_mismatch",
        message: "WordPress did not store slug",
      },
      kind: "update_post",
      normalized_paths: [],
      operation_index: 1,
      status: "failed",
      target: "pages/9",
    },
  ],
  requesterOpaque: "requester0000000",
  status: "partial",
};

const approvalHtml = renderApprovalPage({
  csrfToken: "abc123",
  executionId: "exec_1",
  preflight,
  previewDigest: "",
});

describe(escapeHtml, () => {
  it("escapes every html-significant character", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"
    );
  });
});

describe("approval CSRF token", () => {
  it("verifies the execution and subject it was signed for", async () => {
    const token = await approvalCsrfToken(
      "secret",
      "exec_1",
      "subject00000000",
      "preview-a"
    );

    expect(token).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      verifyApprovalCsrfToken(
        "secret",
        "exec_1",
        "subject00000000",
        "preview-a",
        token
      )
    ).resolves.toBeTruthy();
  });

  it("refuses a token minted for another preview of the same run", async () => {
    const token = await approvalCsrfToken(
      "secret",
      "exec_1",
      "subject00000000",
      "preview-a"
    );

    await expect(
      verifyApprovalCsrfToken(
        "secret",
        "exec_1",
        "subject00000000",
        "preview-b",
        token
      )
    ).resolves.toBeFalsy();
  });

  it("refuses a token minted for another run, approver, or secret", async () => {
    const token = await approvalCsrfToken(
      "secret",
      "exec_1",
      "subject00000000",
      "preview-a"
    );

    await expect(
      verifyApprovalCsrfToken(
        "secret",
        "exec_2",
        "subject00000000",
        "preview-a",
        token
      )
    ).resolves.toBeFalsy();
    await expect(
      verifyApprovalCsrfToken(
        "secret",
        "exec_1",
        "other00000000000",
        "preview-a",
        token
      )
    ).resolves.toBeFalsy();
    await expect(
      verifyApprovalCsrfToken(
        "other",
        "exec_1",
        "subject00000000",
        "preview-a",
        token
      )
    ).resolves.toBeFalsy();
  });

  it("refuses a token that is empty or not a signature", async () => {
    await expect(
      verifyApprovalCsrfToken(
        "secret",
        "exec_1",
        "subject00000000",
        "preview-a",
        ""
      )
    ).resolves.toBeFalsy();
    await expect(
      verifyApprovalCsrfToken(
        "secret",
        "exec_1",
        "subject00000000",
        "preview-a",
        "forged"
      )
    ).resolves.toBeFalsy();
  });
});

describe(renderApprovalPage, () => {
  it("renders the intent, one sentence per operation, and escaped values", () => {
    expect(approvalHtml).toContain("Fix the launch &lt;headline&gt;");
    expect(approvalHtml).toContain("Update title and slug on pages 42");
    expect(approvalHtml).toContain("Old &lt;b&gt;title&lt;/b&gt;");
  });

  it("marks an unchanged field and links the target to wp-admin", () => {
    expect(approvalHtml).toContain('class="unchanged"');
    expect(approvalHtml).toContain(
      'href="https://wordpress.example/wp-admin/post.php?post=42&amp;action=edit"'
    );
  });

  it("carries the run, the token, and both decisions in the form", () => {
    expect(approvalHtml).toContain("exec_1");
    expect(approvalHtml).toContain('value="abc123"');
    expect(approvalHtml).toContain('value="approve"');
    expect(approvalHtml).toContain('value="reject"');
  });

  it("loads and runs nothing of its own", () => {
    expect(approvalHtml).not.toContain("<script");
    expect(approvalHtml).not.toContain("http://cdn");
  });

  it("shows the problem and hides approve when preflight failed", () => {
    const html = renderApprovalPage({
      csrfToken: "abc123",
      executionId: "exec_1",
      previewDigest: "",
      problem: {
        code: "stale_expected_modified_gmt",
        message: "pages/42 was last modified at 2026-09-02T09:00:00",
      },
    });

    expect(html).toContain("stale_expected_modified_gmt");
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="reject"');
  });

  it("hides approve when the preflight has no operations and no problem is set", () => {
    const html = renderApprovalPage({
      csrfToken: "abc123",
      executionId: "exec_1",
      preflight: { intent: "x", operations: [] },
      previewDigest: "",
    });

    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="reject"');
  });

  it("renders the notice a second pending write needs", () => {
    const html = renderApprovalPage({
      csrfToken: "abc123",
      executionId: "exec_1",
      notice: "This run needs a further approval.",
      preflight,
      previewDigest: "",
    });

    expect(html).toContain("This run needs a further approval.");
    expect(html).toContain('value="approve"');
  });

  it("renders the run's stated purpose above the write's own intent", () => {
    const html = renderApprovalPage({
      csrfToken: "abc123",
      executionId: "exec_1",
      intent: "Refresh the <launch> page",
      preflight,
      previewDigest: "",
    });

    expect(html).toContain("Refresh the &lt;launch&gt; page");
    expect(html.indexOf("Refresh the &lt;launch&gt; page")).toBeLessThan(
      html.indexOf("Fix the launch &lt;headline&gt;")
    );
  });

  it("renders no stated purpose when the run recorded none", () => {
    expect(approvalHtml).not.toContain("stated purpose");
  });

  it("drops an edit link that is not an https url", () => {
    const html = renderApprovalPage({
      csrfToken: "abc123",
      executionId: "exec_1",
      preflight: {
        intent: "Fix the headline",
        operations: [
          { ...operation, editUrl: "data:text/html,<b>not wp-admin</b>" },
        ],
      },
      previewDigest: "",
    });

    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("<a ");
    expect(html).toContain("pages/42");
  });

  it("renders an already-truncated preview without the rest of the value", () => {
    const truncated = previewValue(
      `<script>alert(1)</script>${"a".repeat(600)}`
    );

    const html = renderApprovalPage({
      csrfToken: "abc123",
      executionId: "exec_1",
      preflight: {
        intent: "Rewrite the body",
        operations: [
          {
            ...operation,
            fields: [
              { after: truncated, before: "", changed: true, path: "content" },
            ],
          },
        ],
      },
      previewDigest: "",
    });

    expect(truncated.endsWith("…")).toBeTruthy();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("a".repeat(600));
  });
});

describe(renderProblemPage, () => {
  it("states the problem and offers no decision", () => {
    const html = renderProblemPage("exec_<1>", {
      code: "no_receipt",
      message: "This run finished without a write receipt.",
    });

    expect(html).toContain("no_receipt");
    expect(html).toContain("This run finished without a write receipt.");
    expect(html).toContain("exec_&lt;1&gt;");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });
});

describe(renderReceiptPage, () => {
  it("names the batch status and both subjects", () => {
    const html = renderReceiptPage(receipt);
    expect(html).toContain("partial");
    expect(html).toContain("requester0000000");
    expect(html).toContain("approver00000000");
  });

  it("lists every operation with its paths and its error", () => {
    const html = renderReceiptPage(receipt);
    expect(html).toContain("pages/42");
    expect(html).toContain("Stored by the CMS");
    expect(html).toContain("readback_mismatch");
    expect(html).toContain("WordPress did not store slug");
    expect(html).not.toContain("<form");
  });
});

describe("write outcomes on the approval surfaces", () => {
  const landed: BatchReceipt = {
    approverOpaque: "approver00000000",
    executionId: "exec_9",
    operations: [
      {
        changed_paths: ["title"],
        kind: "update_post",
        normalized_paths: [],
        operation_index: 0,
        status: "changed",
        target: "pages/9",
      },
    ],
    requesterOpaque: "requester0000000",
    status: "succeeded",
  };

  it("shows the receipt, not a timeout, when the script failed after the write", () => {
    const report = {
      calls: [],
      error: "Execution timed out",
      executionId: "exec_9",
      receipt: landed,
      status: "error" as const,
    };

    expect(runEndingProblem(report)).toBeUndefined();
    expect(writeNotice(report)).toContain("The change below was applied");
    expect(renderReceiptFragment(landed, writeNotice(report))).toContain(
      "Result: succeeded (1 of 1 operations confirmed)"
    );
  });

  it("says an interrupted write may have landed", () => {
    expect(
      writeNotice({
        calls: [],
        executionId: "exec_9",
        receipt: { ...landed, status: "partial" },
        receiptInterrupted: true,
        status: "error",
      })
    ).toContain("may or may not have been written");
  });

  it("renders progress escaped, with what is still waiting", () => {
    const html = renderProgressFragment({
      approverOpaque: "a",
      executionId: "exec_9",
      operations: landed.operations.map((item) => ({
        ...item,
        target: "<b>pages/9</b>",
      })),
      requesterOpaque: "r",
      startedAt: 1,
      targets: ["<b>pages/9</b>", "pages/10"],
      total: 2,
      updatedAt: 1,
    });

    expect(html).toContain("1 of 2 operations done");
    expect(html).toContain("&lt;b&gt;pages/9&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("Still working on: <code>pages/10</code>");
  });
});
