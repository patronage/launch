import { sectionOptions } from "@launch/adapter-emdash";
import type { EmDashFormBlock } from "@launch/adapter-emdash";
import { Content, PageSection } from "@launch/ui";
import type { ReactNode } from "react";

import { adapter } from "./page-view";

interface Props {
  section: EmDashFormBlock;
  children?: ReactNode;
}

/**
 * A form section: the section options, heading and body in the shared UI,
 * with the forms plugin's form (rendered by Astro) as `children`.
 */
export const FormSectionFrame = ({ section, children }: Props) => {
  const intro = adapter.toPage({
    data: {
      sections: [
        {
          _key: section._key ?? "form",
          _type: "content",
          body: section.body,
          heading: section.heading,
        },
      ],
    },
    slug: "form",
  }).sections[0]?.block;

  return (
    <PageSection options={sectionOptions(section)}>
      <div className="flex max-w-2xl flex-col gap-10">
        {intro?.type === "content" && (intro.heading || intro.body) ? (
          <Content block={intro} />
        ) : null}
        <div className="launch-form">{children}</div>
      </div>
    </PageSection>
  );
};
