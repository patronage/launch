/**
 * The WPGraphQL for ACF response shape for the Page Builder, generated from
 * src/page-builder.graphql and apps/web-wordpress/schema.graphql by
 * `pnpm codegen` into src/gql/.
 */
import type {
  PageBuilderFieldsFragment,
  PageBuilderImageFragment,
  PageBuilderLinkFragment,
  PageBuilderLinksFragment,
  PageBuilderSectionOptionsFragment,
  PageSectionsQuery,
} from "./gql/graphql";

export type {
  PageBuilderFieldsFragment,
  PageSectionsQuery,
} from "./gql/graphql";

export type AcfImage = PageBuilderImageFragment;

export type AcfLink = PageBuilderLinkFragment;

export type AcfLinkRow = PageBuilderLinksFragment;

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
