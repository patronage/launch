#!/usr/bin/env bash
# Seeds invented demo content: a home page, an about page with hero fields, a
# post, a draft for trying previews, and the primary menu. Skips what exists.
set -euo pipefail
cd "$(dirname "$0")/.."

wp() { docker compose run --rm -T cli wp "$@"; }

# Prints the ID of the page or post with this slug, creating it if needed.
ensure_post() {
  local type="$1" slug="$2" status="$3" title="$4" content="$5"
  local id
  id="$(wp post list --post_type="$type" --name="$slug" --post_status=any --field=ID --format=ids)"
  if [[ -z "$id" ]]; then
    id="$(wp post create --post_type="$type" --post_name="$slug" --post_author=1 --post_status="$status" \
      --post_title="$title" --post_content="$content" --porcelain)"
  fi
  echo "$id"
}

hero() {
  local id="$1" eyebrow="$2" headline="$3" intro="$4"
  wp post meta update "$id" eyebrow "$eyebrow" >/dev/null
  wp post meta update "$id" _eyebrow field_patronage_headless_hero_eyebrow >/dev/null
  wp post meta update "$id" headline "$headline" >/dev/null
  wp post meta update "$id" _headline field_patronage_headless_hero_headline >/dev/null
  wp post meta update "$id" intro "$intro" >/dev/null
  wp post meta update "$id" _intro field_patronage_headless_hero_intro >/dev/null
}

# WordPress's own sample content.
for slug in hello-world sample-page privacy-policy; do
  for id in $(wp post list --post_type=post,page --name="$slug" --post_status=any --field=ID --format=ids); do
    wp post delete "$id" --force >/dev/null
  done
done

home="$(ensure_post page home publish 'Home' '<!-- wp:paragraph --><p>This page is written in WordPress and rendered by vinext.</p><!-- /wp:paragraph -->')"
hero "$home" 'Launch' 'A headless WordPress demo' 'Content comes from WPGraphQL; the page is rendered by a vinext app.'

about="$(ensure_post page about publish 'About' '<!-- wp:heading --><h2 class="wp-block-heading">What this is</h2><!-- /wp:heading --><!-- wp:paragraph --><p>An invented organisation, used to show a WordPress page with ACF fields rendered by vinext.</p><!-- /wp:paragraph -->')"
hero "$about" 'About' 'About the Example Collective' 'A fictional group that exists only in this demo.'
wp post meta update "$about" cta --format=json '{"title":"Read the news","url":"/news/hello-headless/","target":""}' >/dev/null
wp post meta update "$about" _cta field_patronage_headless_hero_cta >/dev/null

ensure_post post hello-headless publish 'Hello, headless' '<!-- wp:paragraph --><p>A post published in WordPress. Edit it and the front-end revalidates.</p><!-- /wp:paragraph -->' >/dev/null
ensure_post page coming-soon draft 'Coming soon' '<!-- wp:paragraph --><p>A draft, only visible through Preview.</p><!-- /wp:paragraph -->' >/dev/null

wp option update show_on_front page >/dev/null
wp option update page_on_front "$home" >/dev/null
# Posts live under /news/ so they do not collide with pages.
wp rewrite structure '/news/%postname%/' >/dev/null

if ! wp menu list --fields=slug --format=csv | grep -qx primary; then
  wp menu create Primary >/dev/null
  wp menu item add-post primary "$home" --title=Home >/dev/null
  wp menu item add-post primary "$about" >/dev/null
  wp menu location assign primary primary
fi

echo "Seeded demo content."
