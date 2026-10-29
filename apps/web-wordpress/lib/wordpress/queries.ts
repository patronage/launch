import { graphql } from "@/gql";

export const ContentFields = graphql(`
  fragment ContentFields on ContentNode {
    __typename
    databaseId
    uri
    status
    ... on NodeWithTitle {
      title
    }
    ... on NodeWithContentEditor {
      content
    }
    ... on Post {
      date
      author {
        node {
          name
        }
      }
    }
    ... on WithAcfHero {
      hero {
        eyebrow
        headline
        intro
        cta {
          title
          url
          target
        }
      }
    }
  }
`);

export const ContentByUriQuery = graphql(`
  query ContentByUri($uri: String!) {
    nodeByUri(uri: $uri) {
      ... on ContentNode {
        ...ContentFields
      }
    }
  }
`);

// Previews send the post's ID in the X-GraphQL-Preview header (see client.ts);
// WPGraphQL then overlays its latest unsaved changes on these fields.
export const PreviewContentQuery = graphql(`
  query PreviewContent($id: ID!) {
    contentNode(id: $id, idType: DATABASE_ID) {
      ...ContentFields
    }
  }
`);

export const LayoutQuery = graphql(`
  query Layout {
    generalSettings {
      title
      description
    }
    menuItems(where: { location: PRIMARY }, first: 20) {
      nodes {
        id
        label
        uri
        target
      }
    }
  }
`);
