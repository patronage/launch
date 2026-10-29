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

export interface AcfButton {
  link: AcfLink | null;
  style: AcfSelect;
}

export interface AcfSectionOptions {
  background: AcfSelect;
  containerWidth: AcfSelect;
  paddingTop: AcfSelect;
  paddingBottom: AcfSelect;
  hide: boolean | null;
  anchor: string | null;
}

interface LayoutBase<T extends string> {
  __typename: T;
  sectionOptions: AcfSectionOptions | null;
}

export interface ContentLayout extends LayoutBase<"PageBuilderSectionsContentLayout"> {
  eyebrow: string | null;
  heading: string | null;
  content: string | null;
  alignment: AcfSelect;
  buttons: AcfButton[] | null;
}

export interface ContentMediaLayout extends LayoutBase<"PageBuilderSectionsContentMediaLayout"> {
  eyebrow: string | null;
  heading: string | null;
  content: string | null;
  image: AcfImage | null;
  imagePosition: AcfSelect;
  buttons: AcfButton[] | null;
}

export interface MediaLayout extends LayoutBase<"PageBuilderSectionsMediaLayout"> {
  image: AcfImage | null;
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
  content: string | null;
  buttons: AcfButton[] | null;
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
