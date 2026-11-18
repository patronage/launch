import type {
  EmDashFormBlock,
  EmDashPageData,
  EmDashSection,
  EmDashUnknownSection,
} from "@launch/adapter-emdash";

type AnySection = EmDashSection | EmDashUnknownSection;

/** Sections the shared UI draws, or one form the plugin draws. */
export type Run =
  | { kind: "sections"; data: EmDashPageData; first: boolean }
  | { kind: "form"; section: EmDashFormBlock; first: boolean };

const isForm = (section: AnySection): section is EmDashFormBlock =>
  section._type === "form";

/**
 * Splits a page into runs at each form section. The first run keeps the
 * hero; the rest render their sections only.
 */
export const toRuns = (data: EmDashPageData): Run[] => {
  const runs: Run[] = [];
  let pending: AnySection[] = [];

  const flush = () => {
    if (pending.length > 0 || runs.length === 0) {
      runs.push({
        data:
          runs.length === 0
            ? { ...data, sections: pending }
            : {
                hero_variant: "none",
                sections: pending,
                title: data.title ?? "",
              },
        first: runs.length === 0,
        kind: "sections",
      });
    }

    pending = [];
  };

  for (const section of data.sections ?? []) {
    if (isForm(section)) {
      flush();

      if (section.form && section.section_hidden !== true) {
        runs.push({ first: false, kind: "form", section });
      }
    } else {
      pending.push(section);
    }
  }

  flush();

  return runs;
};
