# Demo content

Shared assets for the local seeds of every CMS, so the WordPress, Payload and EmDash demos show the same invented site (Neighborhood Growers, from the Spike 2 fixtures).

- `images/`: generated placeholder images (abstract gradients, no photos), named as in the adapter fixtures.
- `images.json`: each image's file name, alt text and optional caption.

The page text lives in each CMS's seed, since rich text is CMS-specific. EmDash downloads these images from GitHub when it applies its seed, so a new image only shows there once it is on `main`.
