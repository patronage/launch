import * as migration_20261029_201036_initial from './20261029_201036_initial';
import * as migration_20261029_230616_sections from './20261029_230616_sections';
import * as migration_20261030_185138_posts_preview from './20261030_185138_posts_preview';
import * as migration_20261030_191931_forms from './20261030_191931_forms';
import * as migration_20261030_201407_heroes from './20261030_201407_heroes';
import * as migration_20261110_222855_seo_redirects from './20261110_222855_seo_redirects';
import * as migration_20261113_043418_payload_beta_8 from './20261113_043418_payload_beta_8';
import * as migration_20261113_080320_trash from './20261113_080320_trash';

export const migrations = [
  {
    up: migration_20261029_201036_initial.up,
    down: migration_20261029_201036_initial.down,
    name: '20261029_201036_initial',
  },
  {
    up: migration_20261029_230616_sections.up,
    down: migration_20261029_230616_sections.down,
    name: '20261029_230616_sections',
  },
  {
    up: migration_20261030_185138_posts_preview.up,
    down: migration_20261030_185138_posts_preview.down,
    name: '20261030_185138_posts_preview',
  },
  {
    up: migration_20261030_191931_forms.up,
    down: migration_20261030_191931_forms.down,
    name: '20261030_191931_forms',
  },
  {
    up: migration_20261030_201407_heroes.up,
    down: migration_20261030_201407_heroes.down,
    name: '20261030_201407_heroes',
  },
  {
    up: migration_20261110_222855_seo_redirects.up,
    down: migration_20261110_222855_seo_redirects.down,
    name: '20261110_222855_seo_redirects',
  },
  {
    up: migration_20261113_043418_payload_beta_8.up,
    down: migration_20261113_043418_payload_beta_8.down,
    name: '20261113_043418_payload_beta_8',
  },
  {
    up: migration_20261113_080320_trash.up,
    down: migration_20261113_080320_trash.down,
    name: '20261113_080320_trash'
  },
];
