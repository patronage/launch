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

// WPGraphQL 2 dropped the asPreview argument: unsaved changes are the
// latest revision, reached through the preview edge.
export const PreviewContentQuery = graphql(`
  query PreviewContent($id: ID!) {
    contentNode(id: $id, idType: DATABASE_ID) {
      ...ContentFields
      ... on Page {
        preview {
          node {
            ...ContentFields
          }
        }
      }
      ... on Post {
        preview {
          node {
            ...ContentFields
          }
        }
      }
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
