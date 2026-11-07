/**
 * The WPGraphQL for ACF response shape for the Page Builder and the hero, generated from
 * src/page-builder.graphql and apps/web-wordpress/schema.graphql by
 * `pnpm codegen` into src/gql/.
 */
import type {
  PageBuilderFieldsFragment,
  PageBuilderFormFragment,
  PageBuilderImageFragment,
  PageBuilderLinkFragment,
  PageBuilderLinksFragment,
  PageBuilderSectionOptionsFragment,
  PageHeroFieldsFragment,
  PageSectionsQuery,
} from "./gql/graphql";

export type {
  PageBuilderFieldsFragment,
  PageHeroFieldsFragment,
  PageSectionsQuery,
} from "./gql/graphql";

export type AcfImage = PageBuilderImageFragment;

export type AcfLink = PageBuilderLinkFragment;

/** A row of a links repeater, in a section or the hero. */
export type AcfLinkRow = Pick<PageBuilderLinksFragment, "link" | "variant">;

export type AcfHero = NonNullable<PageHeroFieldsFragment["hero"]>;

/** A Formidable form, as the theme exposes it (inc/forms.php). */
export type AcfForm = PageBuilderFormFragment;

export type AcfFormField = PageBuilderFormFragment["fields"][number];

export type AcfSectionOptions = PageBuilderSectionOptionsFragment;

/** One Page Builder section, of one of the layouts the adapter knows. */
export type Layout = NonNullable<
  NonNullable<
    NonNullable<PageBuilderFieldsFragment["pageBuilder"]>["sections"]
  >[number]
>;

/**
 * A layout this adapter does not know, e.g. one added in the CMS before the
 * front-end regenerated its schema.
 */
export interface UnknownLayout {
  __typename: string;
  sectionOptions?: AcfSectionOptions | null;
}

export interface PageQueryResult {
  data: PageSectionsQuery;
}
