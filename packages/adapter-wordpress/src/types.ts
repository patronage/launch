/**
 * The WPGraphQL for ACF response shape for the page builder in
 * fixtures/query.graphql. Hand-written for the spike; a real app would
 * generate these from the schema.
 */

/** WPGraphQL for ACF returns select fields as string arrays. */
export type AcfSelect = string[] | string | null;

export interface AcfLink {
  title: string | null;
  url: string | null;
  target: string | null;
}

export interface AcfImage {
  node: {
    sourceUrl: string | null;
    altText: string | null;
    /** WordPress returns captions as HTML, e.g. "<p>Text</p>\n". */
    caption: string | null;
    mediaDetails: { width: number | null; height: number | null } | null;
  } | null;
}

export interface AcfLinkRow {
  link: AcfLink | null;
  variant: AcfSelect;
}

export interface AcfSectionOptions {
  skin: AcfSelect;
  width: AcfSelect;
  paddingTop: AcfSelect;
  paddingBottom: AcfSelect;
  anchor: string | null;
  hidden: boolean | null;
}

interface LayoutBase<T extends string> {
  __typename: T;
  sectionOptions: AcfSectionOptions | null;
}

export interface ContentLayout extends LayoutBase<"PageBuilderSectionsContentLayout"> {
  eyebrow: string | null;
  heading: string | null;
  body: string | null;
  align: AcfSelect;
  links: AcfLinkRow[] | null;
}

export interface ContentMediaLayout extends LayoutBase<"PageBuilderSectionsContentMediaLayout"> {
  eyebrow: string | null;
  heading: string | null;
  body: string | null;
  media: AcfImage | null;
  mediaPosition: AcfSelect;
  links: AcfLinkRow[] | null;
}

export interface MediaLayout extends LayoutBase<"PageBuilderSectionsMediaLayout"> {
  media: AcfImage | null;
}

export interface AcfCard {
  title: string | null;
  text: string | null;
  image: AcfImage | null;
  link: AcfLink | null;
}

export interface CardGridLayout extends LayoutBase<"PageBuilderSectionsCardGridLayout"> {
  heading: string | null;
  columns: AcfSelect;
  cards: AcfCard[] | null;
}

export interface BlockquoteLayout extends LayoutBase<"PageBuilderSectionsBlockquoteLayout"> {
  quote: string | null;
  attribution: string | null;
  role: string | null;
  image: AcfImage | null;
}

export interface CallToActionLayout extends LayoutBase<"PageBuilderSectionsCallToActionLayout"> {
  heading: string | null;
  body: string | null;
  links: AcfLinkRow[] | null;
}

export type Layout =
  | ContentLayout
  | ContentMediaLayout
  | MediaLayout
  | CardGridLayout
  | BlockquoteLayout
  | CallToActionLayout;

/** A layout this adapter does not know, e.g. one added in the CMS before the front-end. */
export interface UnknownLayout {
  __typename: string;
  sectionOptions?: AcfSectionOptions | null;
}

export interface PageQueryResult {
  data: {
    page: {
      title: string | null;
      uri: string | null;
      pageBuilder: { sections: (Layout | UnknownLayout)[] | null } | null;
    } | null;
  };
}
