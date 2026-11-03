// The bindings the WordPress connector reads.
export interface WordPressEnv {
  // Service token for the Access application in front of WordPress, when
  // there is one.
  WORDPRESS_ACCESS_CLIENT_ID?: string;
  WORDPRESS_ACCESS_CLIENT_SECRET?: string;
  // Signs the gateway proof the `patronage-access` mu-plugin checks.
  WORDPRESS_ACCESS_PROOF_SECRET?: string;
  // The WordPress origin, without /wp-json. HTTPS outside localhost.
  WORDPRESS_API_URL?: string;
}
